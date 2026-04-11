# ADR-0013: Subagent Task Decomposition

## Status: Approved

## Date: 2026-04-10

## Context

Subagent sessions have full tool access (exec, read, edit, write, PluresLM tools) but consistently fail on large tasks. Root cause analysis of 27 subagent sessions shows:

- Tasks with focused scope (ADO snapshot fix, Teams extraction) succeed: 30-40 tool calls, 30-120s
- Tasks requiring large text generation (ADR writing, Connect guide, PPTX) fail: 0-4 tool calls, timeout at ~80s
- The model response generation timeout (~80s per turn) is the binding constraint, not tool availability

The failure mode: the subagent receives a massive task, makes 1-2 searches, then attempts to generate the entire output in one response and times out.

## Decision

### 1. Task Size Limit

No single subagent task should require more than ~2000 chars of output in a single response. If the expected output is larger, the brain decomposes it before dispatching.

### 2. Procedure-Based Context Assembly

Instead of telling subagents to "search PluresLM for X", the brain should:
1. Run the relevant procedure or search BEFORE spawning
2. Include the results INLINE in the task description
3. The subagent gets pre-assembled context and only needs to ACT, not research

Pattern:
```
Brain: pluresLM_search("ADR-0012 authorization gate") → gets 5 results
Brain: sessions_spawn(task: "Write ADR-0011. Here is the context: [inline results]. Write to file X.")
```

NOT:
```
Brain: sessions_spawn(task: "Search PluresLM for context, then write ADR-0011")
```

### 3. Automatic Decomposition via Procedure

A new procedure `task-decompose` fires when the brain is about to spawn a subagent. It:

1. Estimates output size from the task description
2. If >2000 chars expected output, splits into subtasks:
   - Research phase (search + collect context) → brain does this
   - Creation phases (one per output artifact) → each a separate subagent
   - Verification phase (check output exists) → brain does this
3. Each subtask gets inline context from the research phase

Example decomposition for "Write Connect guide with reflections + goals + attachments":
```
Subtask 1: Brain searches PluresLM for work item summary, IC4 goals, feedback themes
Subtask 2: Subagent writes Reflection 1 (6000 chars) — given inline context
Subtask 3: Subagent writes Reflection 2 (1000 chars) — given inline context  
Subtask 4: Subagent writes H2 Goals — given inline context
Subtask 5: Subagent writes checklist — given inline context
Brain: Assembles all parts into final guide
```

### 4. Context Budget per Subagent

- Task description: ≤500 words
- Inline context: ≤3000 words (pre-assembled by brain)
- Expected output per subtask: ≤2000 chars
- Total tools per subtask: ≤20

### 5. Parallelism Maximization

Subtasks that don't depend on each other run in parallel. The brain:
1. Identifies the dependency graph in decomposition
2. Spawns independent subtasks simultaneously
3. Waits for results via sessions_yield
4. Spawns dependent subtasks with prior results as context

## Consequences

- Large tasks stop failing silently — they get decomposed into succeeding small tasks
- Brain does research, subagents do execution — plays to each role's strength  
- Parallel subtasks reduce wall-clock time for complex work
- More subagent sessions but each completes successfully
- Brain maintains coherence across subtasks (it assembles the final output)
