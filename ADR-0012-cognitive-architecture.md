# ADR-0012: Cognitive Architecture — Brain/Hands Model

## Status: Proposed

## Context

The main agent session and subagent sessions have identical capabilities — same memory, same tools. The only real difference is authorization context (who approved what). Currently:

- Procedures fire on events but emit to nowhere (results discarded)
- Subagents are spawned ad-hoc with manually-assembled context
- No relevance filtering — all updates treated equally
- No authorization gate — thinking about work could accidentally trigger work
- No batching — updates are either immediate or lost

## Decision

Restructure the agent architecture as a cognitive model:

### Roles

- **Brain** (main session): Thinks, decides, authorizes. Receives filtered updates.
- **Hands** (subagents): Execute authorized work. Full memory access via PluresLM.
- **Nervous System** (procedures): Routes signals between brain and hands. Filters, batches, gates.

### Procedure Pipeline

#### Outbound (Brain → Hands)

1. Brain stores a decision or WIP item with intent
2. `after_store` procedure detects actionable intent
3. Procedure emits a **proposal** (not an action) with:
   - What needs to happen
   - Related context (from memory search)
   - Suggested authorization level (low/medium/high risk)
4. Plugin surfaces proposal to brain via:
   - **Low risk**: Inline button `[Authorize] [Skip]` 
   - **Medium risk**: System event with details, awaits explicit response
   - **High risk**: Full message to user with explanation
5. On authorization, plugin spawns subagent with session key `pluresLM-task-{memoryId}`
6. Subagent searches PluresLM for its own context — no manual assembly

#### Inbound (Hands → Brain)

1. Subagent stores progress via `pluresLM_store` (category: work-in-progress, source: subagent:*)
2. `after_store` procedure fires with `filter: { source_prefix: "subagent:" }`
3. Procedure searches for brain's recent context (last 3 stored items or current focus)
4. Computes relevance: semantic similarity between update and brain's focus
5. Emits with relevance tier:
   - **Immediate** (>0.8): Plugin injects system event — brain sees it next turn
   - **Batched** (0.5-0.8): Plugin adds to batch buffer, surfaces on idle or break
   - **Silent** (<0.5): Stored in memory, brain can search later

#### Authorization Tiers

| Tier | Trigger | Gate | Example |
|------|---------|------|---------|
| **Auto** | Procedure detects routine pattern | None — pre-authorized by rule | Updating a WIP item's status |
| **Effortless** | New work detected | Inline button / emoji reaction | "Fix CI in repo X" → [✅ Go] |
| **Explicit** | Destructive or external action | Full user confirmation | "Delete 47 workflow files" |
| **Blocked** | Violates constraint | Cannot proceed | Nudging Copilot (C-COP-001) |

### Idle Detection

Brain's activity state affects batching:
- **Active** (responded <5 min ago): Only immediate-tier updates interrupt
- **Working** (in multi-turn task): Batch everything, surface on completion
- **Idle** (>15 min since last turn): Flush all batched updates as digest
- **Quiet hours** (23:00-08:00): Store only, no injection

### Memory Protocol

Subagents use PluresLM directly. No context assembly by the brain.

Subagent session prompt should include:
```
You have access to PluresLM memory tools. Search for context before starting work.
Store your findings and progress as you go. Your brain agent will see updates
through the same memory system.
```

### Implementation Phases

**Phase 1: Wiring** (current)
- [x] Daemon returns procedure actions in store response
- [x] Plugin dispatches actions (subagent spawn, system event)
- [ ] Fix praxis-evidence-capture procedure update (errored)
- [ ] Authorization gate (inline buttons for proposals)

**Phase 2: Relevance**
- [ ] Subagent progress `after_store` procedure with relevance scoring
- [ ] Batch buffer in plugin (memory-backed, survives restart)
- [ ] Idle detection based on last turn timestamp

**Phase 3: Intelligence**
- [ ] Brain focus tracking (what am I working on right now?)
- [ ] Dynamic batch threshold adjustment
- [ ] Subagent self-search context injection in session prompt
- [ ] Progress digest generation for idle flush

## Consequences

- Every subagent has the brain's full memory — same PluresLM access
- Authorization is explicit but effortless (buttons, not approvals)
- Relevance filtering prevents update spam during deep work
- Batching ensures nothing is lost but nothing is distracting
- Hard constraints (C-COP-001 etc.) act as blocked-tier gates — no authorization can override
