/**
 * Default task tracking procedures — shipped with PluresLM.
 *
 * These procedures implement the task completion graph:
 * 1. task-register: detects commitments in stored content, creates task nodes
 * 2. task-action-link: links work artifacts to open tasks
 * 3. task-heartbeat-eval: evaluates task staleness on heartbeat cue
 *
 * Tasks are stored as PluresLM memories with category "task" and structured
 * metadata. The completion graph is the set of edges between tasks and
 * work-in-progress memories. Inaction = a task node with no edges.
 */

import type { ProcedureDefinition } from "./procedures.js";

// ── Procedure Definitions ───────────────────────────────────────────────────

const TASK_REGISTER: Omit<ProcedureDefinition, "id" | "version" | "created_at" | "updated_at" | "run_count" | "last_run_at" | "last_run_ok" | "stats"> = {
  name: "task-register",
  description: "Detect task commitments in stored content and create task nodes. Triggers on all stores — the transform step decides if a commitment exists.",
  enabled: true,
  trigger: {
    kind: "after_store" as const,
    // No category filter — commitments can appear in any store
  },
  steps: [
    {
      kind: "transform",
      params: {
        inputs: ["$input"],
        instruction: `Analyze this stored content for task commitments.
A task commitment is when the agent says it WILL do something specific — not a description of past work.
Look for patterns: "I will...", "I'll...", "assigned to...", "next step:", "TODO:", "task:", "need to...", "going to...", "plan to...", "should...".
If a commitment exists, return JSON: { "found": true, "description": "<what needs to be done>", "assignee": "<who, default 'self'>", "source_id": "<$input.id>" }
If no commitment, return: { "found": false }
Do NOT flag routine observations, status updates, or descriptions of completed work.`,
        mode: "structured",
      },
      as: "commitment",
    },
    {
      kind: "conditional",
      params: {
        field: "$commitment.found",
        op: "==",
        value: true,
        then: [
          {
            kind: "store",
            params: {
              content: "$commitment.description",
              category: "task",
              tags: ["status:open", "type:commitment"],
              source: "task-register",
            },
          },
        ],
      },
    },
  ],
};

const TASK_ACTION_LINK: Omit<ProcedureDefinition, "id" | "version" | "created_at" | "updated_at" | "run_count" | "last_run_at" | "last_run_ok" | "stats"> = {
  name: "task-action-link",
  description: "Link work artifacts to open tasks. Triggers on work-in-progress stores. Searches for matching open tasks and updates their action count.",
  enabled: true,
  trigger: {
    kind: "after_store" as const,
    filter: { category: "work-in-progress" },
  },
  steps: [
    // Find all open tasks
    {
      kind: "search_text",
      params: {
        query: "category:task status:open",
        limit: 30,
      },
      as: "open_tasks",
    },
    // Use transform to match the new work against open tasks
    {
      kind: "transform",
      params: {
        inputs: ["$open_tasks", "$input"],
        instruction: `Match this work artifact against the open tasks.
For each open task, determine if this work is related to completing that task.
Return JSON: { "matches": [{ "task_id": "<id>", "task_content": "<description>", "relevance": "high|medium|low" }] }
Only include matches with medium or high relevance.
If no tasks match, return: { "matches": [] }`,
        mode: "structured",
      },
      as: "matched",
    },
    // If matches found, update the first matched task
    {
      kind: "conditional",
      params: {
        field: "$matched.matches",
        op: "not_empty",
        then: [
          {
            kind: "update",
            params: {
              id: "$matched.matches[0].task_id",
              tags: ["status:in-progress", "type:commitment"],
            },
          },
        ],
      },
    },
  ],
};

const TASK_HEARTBEAT_EVAL: Omit<ProcedureDefinition, "id" | "version" | "created_at" | "updated_at" | "run_count" | "last_run_at" | "last_run_ok" | "stats"> = {
  name: "task-heartbeat-eval",
  description: "Evaluate task staleness on heartbeat. Scans open tasks, flags stale ones (>24h with no progress, >72h regardless). Emits stale-tasks-detected event.",
  enabled: true,
  trigger: {
    kind: "on_cue" as const,
    cue: "heartbeat",
  },
  steps: [
    // Find all open tasks
    {
      kind: "search_text",
      params: {
        query: "category:task status:open",
        limit: 50,
      },
      as: "open_tasks",
    },
    // Also find in-progress tasks
    {
      kind: "search_text",
      params: {
        query: "category:task status:in-progress",
        limit: 50,
      },
      as: "active_tasks",
    },
    // Evaluate staleness
    {
      kind: "transform",
      params: {
        inputs: ["$open_tasks", "$active_tasks"],
        instruction: `Evaluate task completion status.
For each task:
- Calculate age in hours from created_at to now
- "open" status with age > 24h and no linked actions = STALE
- "open" status with age > 72h = STALE regardless
- "in-progress" with age > 72h since last update = AT_RISK
Return JSON:
{
  "stale": [{ "id": "<id>", "description": "<content>", "age_hours": <n>, "status": "<status>" }],
  "at_risk": [{ "id": "<id>", "description": "<content>", "age_hours": <n>, "status": "<status>" }],
  "healthy": <count>,
  "summary": "<human-readable summary of all open obligations>"
}`,
        mode: "structured",
      },
      as: "evaluation",
    },
    // Emit if there are stale or at-risk tasks
    {
      kind: "conditional",
      params: {
        field: "$evaluation.stale",
        op: "not_empty",
        then: [
          {
            kind: "emit",
            params: {
              event: "stale-tasks-detected",
              data: "$evaluation",
            },
          },
        ],
      },
    },
  ],
};

// ── Completion Procedure ────────────────────────────────────────────────────

const TASK_COMPLETE: Omit<ProcedureDefinition, "id" | "version" | "created_at" | "updated_at" | "run_count" | "last_run_at" | "last_run_ok" | "stats"> = {
  name: "task-complete",
  description: "Manually mark a task as complete. Requires task_id in input context. Updates status tag to completed.",
  enabled: true,
  trigger: {
    kind: "manual" as const,
  },
  steps: [
    {
      kind: "update",
      params: {
        id: "$input.task_id",
        tags: ["status:completed", "type:commitment"],
      },
    },
    {
      kind: "emit",
      params: {
        event: "task-completed",
        data: { task_id: "$input.task_id" },
      },
    },
  ],
};

// ── Export ───────────────────────────────────────────────────────────────────

export const DEFAULT_TASK_PROCEDURES = [
  TASK_REGISTER,
  TASK_ACTION_LINK,
  TASK_HEARTBEAT_EVAL,
  TASK_COMPLETE,
];
