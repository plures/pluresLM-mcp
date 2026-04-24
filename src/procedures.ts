/**
 * Procedure Engine for pluresLM-mcp
 *
 * Stored procedures are named, persisted DSL pipelines that execute
 * multi-step memory operations. They can be triggered manually,
 * on events (after_store, before_search), or on a schedule.
 *
 * Procedures are themselves stored in the memory DB with
 * category "system:procedure" — they persist, sync, and replicate
 * like any other memory.
 */

import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export type TriggerKind = "manual" | "after_store" | "before_search" | "after_search" | "cron" | "on_cue";

export interface ProcedureTrigger {
  kind: TriggerKind;
  /** Cron expression (only for kind=cron) */
  cron?: string;
  /** Filter: only fire when stored memory matches (only for after_store) */
  filter?: Record<string, unknown>;
  /** Cue name (only for kind=on_cue) */
  cue?: string;
}

export type StepKind =
  | "search"      // vector search
  | "search_text" // keyword search
  | "filter"      // filter pipeline results
  | "sort"        // sort results
  | "limit"       // limit results
  | "merge"       // merge parallel results (RRF, interleave, union)
  | "store"       // store a memory
  | "update"      // update memory fields
  | "delete"      // delete matching memories
  | "transform"   // transform results (summarize, compress, reformat)
  | "cue"         // trigger another procedure or agent
  | "parallel"    // run steps in parallel
  | "conditional" // if/then/else
  | "assign"      // assign to variable
  | "emit";       // emit structured output

export interface ProcedureStep {
  kind: StepKind;
  /** Step-specific parameters */
  params: Record<string, unknown>;
  /** Variable name to store result in (default: $pipeline) */
  as?: string;
}

export interface ProcedureDefinition {
  id: string;
  name: string;
  description?: string;
  trigger: ProcedureTrigger;
  steps: ProcedureStep[];
  /** Procedure metadata */
  version: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  /** Who created this */
  created_by?: string;
  /** Execution stats */
  stats: {
    run_count: number;
    last_run_at?: number;
    last_run_ms?: number;
    error_count: number;
    last_error?: string;
  };
}

export interface ProcedureRunContext {
  /** The event that triggered execution */
  trigger_event?: Record<string, unknown>;
  /** Variables accessible to steps ($input, $pipeline, custom) */
  vars: Record<string, unknown>;
  /** Reference to the memory DB for executing steps */
  db: ProcedureDbInterface;
  /** Embed function */
  embed: (text: string) => Promise<number[]>;
  /** Cue callback — fires another procedure or notifies an agent */
  onCue?: (name: string, payload: Record<string, unknown>) => Promise<void>;
}

/** Minimal DB interface the procedure engine needs */
export interface ProcedureDbInterface {
  vectorSearch(query: number[], limit: number, minScore?: number): Promise<Array<{ entry: { id: string; content: string; tags: string[]; category?: string; source: string; created_at: number }; score: number }>>;
  searchText(query: string, opts?: { limit?: number; category?: string }): Promise<Array<{ id: string; content: string; tags: string[]; category?: string; source: string; created_at: number }>>;
  store(content: string, embedding: number[], opts?: Record<string, unknown>): Promise<{ entry: { id: string } }>;
  update(id: string, fields: Record<string, unknown>): Promise<void | boolean>;
  delete(id: string): Promise<void | boolean>;
  execIr(steps: unknown[]): unknown;
}

export interface ProcedureResult {
  procedure: string;
  success: boolean;
  output: unknown;
  duration_ms: number;
  steps_executed: number;
  error?: string;
}

/**
 * Structured export of one or more procedures — used for backup and migration.
 */
export interface ProcedureExport {
  version: string;
  exported_at: number;
  procedure_count: number;
  procedures: ProcedureDefinition[];
}

/**
 * A named, versioned collection of procedures — shareable across instances.
 * Procedures are embedded in full so a bundle is self-contained.
 */
export interface ProcedureBundle {
  name: string;
  version: string;
  description?: string;
  /** SemVer constraints on pluresLM-mcp (e.g. "pluresLM-mcp >= 2.11.0") */
  requires?: string[];
  procedures: ProcedureDefinition[];
  tags?: string[];
  created_at: number;
}

/** Result of an import (procedures or bundle). */
export interface ImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

const PROCEDURE_CATEGORY = "system:procedure";
const BUNDLE_CATEGORY = "system:procedure-bundle";
const MAX_STEPS = 50;

// ============================================================================
// Procedure Engine
// ============================================================================

export class ProcedureEngine {
  private procedures: Map<string, ProcedureDefinition> = new Map();
  private cronTimers: Map<string, NodeJS.Timeout> = new Map();
  private db: ProcedureDbInterface;
  private embed: (text: string) => Promise<number[]>;
  private onCue?: (name: string, payload: Record<string, unknown>) => Promise<void>;
  private debug: boolean;

  constructor(opts: {
    db: ProcedureDbInterface;
    embed: (text: string) => Promise<number[]>;
    onCue?: (name: string, payload: Record<string, unknown>) => Promise<void>;
    debug?: boolean;
  }) {
    this.db = opts.db;
    this.embed = opts.embed;
    this.onCue = opts.onCue;
    this.debug = opts.debug ?? false;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  async create(def: {
    name: string;
    description?: string;
    trigger: ProcedureTrigger;
    steps: ProcedureStep[];
    created_by?: string;
  }): Promise<ProcedureDefinition> {
    if (!def.name || !def.steps?.length) throw new Error("name and steps required");
    if (def.steps.length > MAX_STEPS) throw new Error(`max ${MAX_STEPS} steps`);
    if (this.procedures.has(def.name)) throw new Error(`procedure "${def.name}" already exists`);

    const proc: ProcedureDefinition = {
      id: randomUUID(),
      name: def.name,
      description: def.description,
      trigger: def.trigger,
      steps: def.steps,
      version: 1,
      enabled: true,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: def.created_by,
      stats: { run_count: 0, error_count: 0 },
    };

    // Persist as a memory entry
    const embedding = await this.embed(`procedure: ${proc.name} — ${proc.description ?? ""}`);
    await this.db.store(JSON.stringify(proc), embedding, {
      tags: ["procedure", `proc:${proc.name}`],
      category: PROCEDURE_CATEGORY,
      source: "procedure-engine",
    });

    this.procedures.set(proc.name, proc);
    this._setupTrigger(proc);
    this._log(`created procedure: ${proc.name} (trigger: ${proc.trigger.kind})`);
    return proc;
  }

  async update(name: string, patch: Partial<Pick<ProcedureDefinition, "description" | "trigger" | "steps" | "enabled">>): Promise<ProcedureDefinition> {
    const proc = this.procedures.get(name);
    if (!proc) throw new Error(`procedure "${name}" not found`);

    if (patch.steps && patch.steps.length > MAX_STEPS) throw new Error(`max ${MAX_STEPS} steps`);

    const updated = {
      ...proc,
      ...patch,
      version: proc.version + 1,
      updated_at: Date.now(),
    };

    this.procedures.set(name, updated);
    this._teardownTrigger(proc);
    this._setupTrigger(updated);

    // Re-persist
    const embedding = await this.embed(`procedure: ${updated.name} — ${updated.description ?? ""}`);
    await this.db.store(JSON.stringify(updated), embedding, {
      tags: ["procedure", `proc:${updated.name}`],
      category: PROCEDURE_CATEGORY,
      source: "procedure-engine",
    });

    this._log(`updated procedure: ${name} (v${updated.version})`);
    return updated;
  }

  async remove(name: string): Promise<void> {
    const proc = this.procedures.get(name);
    if (!proc) throw new Error(`procedure "${name}" not found`);
    this._teardownTrigger(proc);
    this.procedures.delete(name);
    this._log(`removed procedure: ${name}`);
  }

  list(): ProcedureDefinition[] {
    return Array.from(this.procedures.values());
  }

  get(name: string): ProcedureDefinition | undefined {
    return this.procedures.get(name);
  }

  // --------------------------------------------------------------------------
  // Load from DB on startup
  // --------------------------------------------------------------------------

  async loadFromDb(): Promise<number> {
    try {
      const results = await this.db.searchText("procedure:", { limit: 100, category: PROCEDURE_CATEGORY });
      let loaded = 0;
      for (const item of results) {
        try {
          const proc = JSON.parse(item.content) as ProcedureDefinition;
          if (proc.name && proc.steps) {
            this.procedures.set(proc.name, proc);
            if (proc.enabled) this._setupTrigger(proc);
            loaded++;
          }
        } catch { /* skip malformed */ }
      }
      this._log(`loaded ${loaded} procedures from DB`);
      return loaded;
    } catch (err) {
      this._log(`failed to load procedures: ${err}`);
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  async run(name: string, context?: Record<string, unknown>): Promise<ProcedureResult> {
    const proc = this.procedures.get(name);
    if (!proc) throw new Error(`procedure "${name}" not found`);
    if (!proc.enabled) throw new Error(`procedure "${name}" is disabled`);
    return this._execute(proc, context);
  }

  /** Fire all procedures matching a trigger kind */
  async fireEvent(kind: TriggerKind, event?: Record<string, unknown>): Promise<ProcedureResult[]> {
    const results: ProcedureResult[] = [];
    for (const proc of this.procedures.values()) {
      if (!proc.enabled || proc.trigger.kind !== kind) continue;

      // Check filter match for after_store
      if (kind === "after_store" && proc.trigger.filter && event) {
        if (!this._matchesFilter(event, proc.trigger.filter)) continue;
      }

      // Check cue name match
      if (kind === "on_cue" && proc.trigger.cue && event?.cue !== proc.trigger.cue) continue;

      try {
        const result = await this._execute(proc, event);
        results.push(result);
      } catch (err) {
        results.push({
          procedure: proc.name,
          success: false,
          output: null,
          duration_ms: 0,
          steps_executed: 0,
          error: String(err),
        });
      }
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Step Execution
  // --------------------------------------------------------------------------

  private async _execute(proc: ProcedureDefinition, triggerEvent?: Record<string, unknown>): Promise<ProcedureResult> {
    const start = Date.now();
    const ctx: ProcedureRunContext = {
      trigger_event: triggerEvent,
      vars: {
        $input: triggerEvent ?? {},
        $pipeline: [],
        $now: Date.now(),
      },
      db: this.db,
      embed: this.embed,
      onCue: this.onCue,
    };

    let stepsExecuted = 0;

    try {
      for (let i = 0; i < proc.steps.length; i++) {
        const step = proc.steps[i];
        if (this._isNativeStep(step)) {
          const group = this._collectNativeSteps(proc.steps, i);
          const result = await this._executeNativeSteps(group.steps, ctx);
          stepsExecuted += group.steps.length;

          const varName = proc.steps[group.endIndex].as ?? "$pipeline";
          ctx.vars[varName] = result;
          i = group.endIndex;
          continue;
        }

        const result = await this._executeStep(step, ctx);
        stepsExecuted++;

        // Assign result to variable (default: $pipeline)
        const varName = step.as ?? "$pipeline";
        ctx.vars[varName] = result;
      }

      const duration = Date.now() - start;
      proc.stats.run_count++;
      proc.stats.last_run_at = Date.now();
      proc.stats.last_run_ms = duration;

      return {
        procedure: proc.name,
        success: true,
        output: ctx.vars.$pipeline,
        duration_ms: duration,
        steps_executed: stepsExecuted,
      };
    } catch (err) {
      const duration = Date.now() - start;
      proc.stats.run_count++;
      proc.stats.error_count++;
      proc.stats.last_error = String(err);
      proc.stats.last_run_at = Date.now();
      proc.stats.last_run_ms = duration;

      return {
        procedure: proc.name,
        success: false,
        output: null,
        duration_ms: duration,
        steps_executed: stepsExecuted,
        error: String(err),
      };
    }
  }

  private async _executeStep(step: ProcedureStep, ctx: ProcedureRunContext): Promise<unknown> {
    const p = this._resolveParams(step.params, ctx.vars);

    switch (step.kind) {
      case "search": {
        const query = String(p.query ?? "");
        const limit = Number(p.limit ?? 10);
        const minScore = Number(p.min_score ?? 0.3);
        const embedding = await ctx.embed(query);
        const results = await ctx.db.vectorSearch(embedding, limit, minScore);
        return results.map(r => ({ ...r.entry, score: r.score }));
      }

      case "search_text": {
        const query = String(p.query ?? "");
        const limit = Number(p.limit ?? 10);
        const category = p.category as string | undefined;
        return await ctx.db.searchText(query, { limit, category });
      }

      case "filter": {
        const pipeline = this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")]);
        const field = String(p.field ?? "");
        const op = String(p.op ?? "==");
        const value = p.value;
        return pipeline.filter((item) => {
          const record = this._asRecord(item);
          const v = record[field];
          switch (op) {
            case "==": return v === value;
            case "!=": return v !== value;
            case ">": return typeof v === "number" && typeof value === "number" ? v > value : false;
            case "<": return typeof v === "number" && typeof value === "number" ? v < value : false;
            case ">=": return typeof v === "number" && typeof value === "number" ? v >= value : false;
            case "<=": return typeof v === "number" && typeof value === "number" ? v <= value : false;
            case "contains": return typeof v === "string" && v.includes(String(value));
            case "in": return Array.isArray(value) && value.includes(v);
            case "has_tag": return Array.isArray(v) && v.includes(String(value));
            default: return true;
          }
        });
      }

      case "sort": {
        const pipeline = [...this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")])];
        const field = String(p.field ?? "created_at");
        const desc = p.desc !== false;
        return pipeline.sort((a, b) => {
          const aValue = this._asRecord(a)[field];
          const bValue = this._asRecord(b)[field];
          const aNum = typeof aValue === "number" ? aValue : 0;
          const bNum = typeof bValue === "number" ? bValue : 0;
          return desc ? bNum - aNum : aNum - bNum;
        });
      }

      case "limit": {
        const pipeline = this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")]);
        return pipeline.slice(0, Number(p.count ?? 10));
      }

      case "merge": {
        // Reciprocal Rank Fusion or simple union
        const sources = (p.sources as string[] ?? ["$a", "$b"]).map(s => this._ensureArray(ctx.vars[s]));
        const strategy = String(p.strategy ?? "rrf");

        if (strategy === "rrf") {
          const k = Number(p.k ?? 60);
          const scores = new Map<string, number>();
          const items = new Map<string, unknown>();
          for (const source of sources) {
            source.forEach((item, rank: number) => {
              const record = this._asRecord(item);
              const id = typeof record.id === "string" ? record.id : JSON.stringify(item);
              scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
              items.set(id, item);
            });
          }
          return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => items.get(id));
        }

        // Union (dedupe by id)
        const seen = new Set<string>();
        const merged: unknown[] = [];
        for (const source of sources) {
          for (const item of source) {
            const record = this._asRecord(item);
            const id = typeof record.id === "string" ? record.id : JSON.stringify(item);
            if (!seen.has(id)) {
              seen.add(id);
              merged.push(item);
            }
          }
        }
        return merged;
      }

      case "store": {
        const content = String(p.content ?? "");
        if (!content) throw new Error("store step requires content");
        const embedding = await ctx.embed(content);
        const result = await ctx.db.store(content, embedding, {
          tags: p.tags as string[] ?? [],
          category: p.category as string,
          source: p.source as string ?? "procedure",
        });
        return result.entry;
      }

      case "transform": {
        const pipeline = this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")]);
        const format = String(p.format ?? "structured");

        if (format === "structured" || format === "jsonl") {
          // Compress to dense structured assertions
          return pipeline.map((item) => {
            const record = this._asRecord(item);
            const out: Record<string, unknown> = {};
            if (record.id) out.id = record.id;
            if (typeof record.content === "string") out.c = record.content.slice(0, 200);
            if (record.category) out.cat = record.category;
            if (Array.isArray(record.tags) && record.tags.length) out.t = record.tags;
            if (typeof record.score === "number") out.s = Math.round(record.score * 100) / 100;
            if (typeof record.created_at === "number") out.ts = record.created_at;
            return out;
          });
        }

        if (format === "fused") {
          // Fuse into a single context block — group by category
          const groups = new Map<string, string[]>();
          for (const item of pipeline) {
            const record = this._asRecord(item);
            const cat = typeof record.category === "string" ? record.category : "general";
            if (!groups.has(cat)) groups.set(cat, []);
            const content = typeof record.content === "string" ? record.content.slice(0, 300) : "";
            groups.get(cat)!.push(content);
          }
          const sections: string[] = [];
          for (const [cat, contents] of groups) {
            sections.push(`[${cat}] ${contents.join(" | ")}`);
          }
          return sections.join("\n");
        }

        return pipeline;
      }

      case "cue": {
        const cueName = String(p.name ?? "");
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        if (ctx.onCue) {
          await ctx.onCue(cueName, { ...payload, $pipeline: ctx.vars.$pipeline });
        }
        // Also fire on_cue procedures
        return cueName;
      }

      case "assign": {
        return p.value ?? ctx.vars[String(p.from ?? "$pipeline")];
      }

      case "conditional": {
        const field = String(p.field ?? "");
        const op = String(p.op ?? "==");
        const value = p.value;
        const source = ctx.vars[String(p.from ?? "$pipeline")];
        const sourceRecord = this._asRecord(source);
        const testValueRaw = Array.isArray(source) ? source.length : sourceRecord[field] ?? source;
        const testValue = testValueRaw as unknown;

        let condition = false;
        switch (op) {
          case "==": condition = testValue === value; break;
          case "!=": condition = testValue !== value; break;
          case ">": condition = typeof testValueRaw === "number" && typeof value === "number" ? testValueRaw > value : false; break;
          case "<": condition = typeof testValueRaw === "number" && typeof value === "number" ? testValueRaw < value : false; break;
          case "empty": condition = Array.isArray(testValueRaw)
            ? testValueRaw.length === 0
            : testValueRaw === undefined || testValueRaw === null || testValueRaw === "";
            break;
          case "not_empty": condition = Array.isArray(testValueRaw)
            ? testValueRaw.length > 0
            : !(testValueRaw === undefined || testValueRaw === null || testValueRaw === "");
            break;
        }

        if (condition && p.then) {
          return this._executeStep(p.then as ProcedureStep, ctx);
        } else if (!condition && p.else) {
          return this._executeStep(p.else as ProcedureStep, ctx);
        }
        return ctx.vars.$pipeline;
      }

      case "parallel": {
        const branches = p.branches as Array<{ steps: ProcedureStep[]; as: string }> ?? [];
        await Promise.all(branches.map(async (branch) => {
          let result: unknown = [];
          for (const s of branch.steps) {
            result = await this._executeStep(s, ctx);
            ctx.vars[s.as ?? "$pipeline"] = result;
          }
          ctx.vars[branch.as] = result;
        }));
        return ctx.vars.$pipeline;
      }

      case "emit": {
        return { output: p.value ?? ctx.vars.$pipeline, format: p.format ?? "json" };
      }

      case "delete": {
        const pipeline = this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")]);
        let deleted = 0;
        for (const item of pipeline) {
          const record = this._asRecord(item);
          const id = typeof record.id === "string" ? record.id : undefined;
          if (id) {
            await ctx.db.delete(id);
            deleted++;
          }
        }
        return { deleted };
      }

      case "update": {
        const pipeline = this._ensureArray(ctx.vars[String(p.from ?? "$pipeline")]);
        const fields = (p.fields ?? {}) as Record<string, unknown>;
        let updated = 0;
        for (const item of pipeline) {
          const record = this._asRecord(item);
          const id = typeof record.id === "string" ? record.id : undefined;
          if (id) {
            await ctx.db.update(id, fields);
            updated++;
          }
        }
        return { updated };
      }

      default:
        throw new Error(`unknown step kind: ${step.kind}`);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private static readonly NATIVE_STEP_KINDS = new Set<StepKind>([
    "filter", "sort", "limit", "search", "search_text",
    "transform", "conditional", "assign", "emit",
  ]);

  private _isNativeStep(step: ProcedureStep): boolean {
    return ProcedureEngine.NATIVE_STEP_KINDS.has(step.kind);
  }

  private _collectNativeSteps(steps: ProcedureStep[], startIndex: number): { steps: ProcedureStep[]; endIndex: number } {
    const collected: ProcedureStep[] = [];
    const first = steps[startIndex];
    if (!this._isNativeStep(first)) {
      return { steps: [first], endIndex: startIndex };
    }

    // Source steps (search/search_text) can begin a native pipeline
    const isSourceStart = first.kind === "search" || first.kind === "search_text";
    const baseFrom = isSourceStart ? "$pipeline" : String((first.params?.from as string | undefined) ?? "$pipeline");

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];
      if (!this._isNativeStep(step)) break;

      // Source steps can only be the first step in a native group
      if (i !== startIndex && (step.kind === "search" || step.kind === "search_text")) break;

      const stepFrom = String((step.params?.from as string | undefined) ?? "$pipeline");
      if (!isSourceStart && stepFrom !== baseFrom) break;

      if (step.as && step.as !== "$pipeline" && i !== startIndex) break;

      collected.push(step);

      if (step.as && step.as !== "$pipeline") break;
    }

    return { steps: collected, endIndex: startIndex + collected.length - 1 };
  }

  private async _executeNativeSteps(steps: ProcedureStep[], ctx: ProcedureRunContext): Promise<unknown> {
    if (!steps.length) return [];

    const irSteps: Array<Record<string, unknown>> = [];

    // Check if the first step is a source step (search/search_text)
    const firstStep = steps[0];
    const isSourcePipeline = firstStep.kind === "search" || firstStep.kind === "search_text";

    if (!isSourcePipeline) {
      // Existing behavior: scope to pipeline IDs
      const firstParams = this._resolveParams(firstStep.params, ctx.vars);
      const fromVar = String(firstParams.from ?? "$pipeline");
      const pipeline = this._ensureArray(ctx.vars[fromVar]);

      if (!pipeline.length) return [];

      const baseIds = pipeline
        .map(item => this._asRecord(item).id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      if (baseIds.length > 0) {
        const predicate = baseIds.length === 1
          ? { field: "id", cmp: "==", value: baseIds[0] }
          : { or: baseIds.map(id => ({ field: "id", cmp: "==", value: id })) };
        irSteps.push({ op: "filter", predicate });
      }
    }

    for (const step of steps) {
      const p = this._resolveParams(step.params, ctx.vars);

      switch (step.kind) {
        case "search": {
          // Vector search — embed query, push as IR VectorSearch
          const query = String(p.query ?? "");
          const limit = Number(p.limit ?? 10);
          const embedding = await ctx.embed(query);
          irSteps.push({ op: "vector_search", embedding, limit, min_score: Number(p.min_score ?? p.minScore ?? 0) });
          break;
        }

        case "search_text": {
          const query = String(p.query ?? "");
          const limit = Number(p.limit ?? 10);
          irSteps.push({ op: "text_search", query, limit, field: String(p.field ?? "text") });
          break;
        }

        case "filter": {
          const field = String(p.field ?? "");
          const op = String(p.op ?? "==");
          const predicate = this._buildNativePredicate(field, op, p.value);
          irSteps.push({ op: "filter", predicate });
          break;
        }

        case "sort": {
          const field = String(p.field ?? "created_at");
          const desc = p.desc !== false;
          irSteps.push({ op: "sort", by: field, dir: desc ? "desc" : "asc" });
          break;
        }

        case "limit": {
          const count = Number(p.count ?? 10);
          irSteps.push({ op: "limit", n: count });
          break;
        }

        case "transform": {
          const format = String(p.format ?? "structured");
          irSteps.push({ op: "transform", format, max_chars: Number(p.max_chars ?? p.maxChars ?? 0) });
          break;
        }

        case "conditional": {
          const condition = p.condition as Record<string, unknown> ?? {};
          const predicate = this._buildNativePredicate(
            String(condition.field ?? ""),
            String(condition.op ?? "=="),
            condition.value,
          );
          irSteps.push({
            op: "conditional",
            predicate,
            then_steps: ((p.then_steps ?? p.thenSteps ?? []) as ProcedureStep[]).map(s => {
              const sp = this._resolveParams(s.params, ctx.vars);
              return this._stepToIr(s.kind, sp);
            }),
            else_steps: ((p.else_steps ?? p.elseSteps ?? []) as ProcedureStep[]).map(s => {
              const sp = this._resolveParams(s.params, ctx.vars);
              return this._stepToIr(s.kind, sp);
            }),
          });
          break;
        }

        case "assign": {
          irSteps.push({ op: "assign", name: String(p.name ?? step.as ?? "result") });
          break;
        }

        case "emit": {
          irSteps.push({ op: "emit", label: String(p.label ?? "output"), from_var: String(p.from_var ?? p.fromVar ?? "") || null });
          break;
        }
      }
    }

    const result = ctx.db.execIr(irSteps);
    return this._normalizeNativeResult(result);
  }

  /** Convert a single step kind + params to an IR op object */
  private _stepToIr(kind: StepKind, p: Record<string, unknown>): Record<string, unknown> {
    switch (kind) {
      case "filter": return { op: "filter", predicate: this._buildNativePredicate(String(p.field ?? ""), String(p.op ?? "=="), p.value) };
      case "sort": return { op: "sort", by: String(p.field ?? "created_at"), dir: p.desc !== false ? "desc" : "asc" };
      case "limit": return { op: "limit", n: Number(p.count ?? 10) };
      default: return { op: "limit", n: 999999 }; // passthrough
    }
  }

  private _normalizeNativeResult(result: unknown): unknown[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      if (Array.isArray(record.nodes)) {
        return record.nodes.map(node => this._unwrapNativeNode(node));
      }
    }
    return [];
  }

  private _unwrapNativeNode(node: unknown): unknown {
    if (node && typeof node === "object" && "data" in node) {
      const record = node as Record<string, unknown>;
      const data = record.data;
      if (data && typeof data === "object") {
        if (!("id" in (data as Record<string, unknown>)) && "id" in record) {
          return { ...(data as Record<string, unknown>), id: record.id };
        }
        return data;
      }
    }
    return node;
  }

  private _buildNativePredicate(field: string, op: string, value: unknown): Record<string, unknown> {
    if (op === "in" && Array.isArray(value)) {
      return { or: value.map(item => ({ field, cmp: "==", value: item })) };
    }

    const cmpMap: Record<string, string> = {
      "==": "==",
      "!=": "!=",
      ">": ">",
      ">=": ">=",
      "<": "<",
      "<=": "<=",
      "contains": "contains",
      "starts_with": "starts_with",
      "matches": "matches",
      "has_tag": "contains",
    };

    return {
      field,
      cmp: cmpMap[op] ?? "==",
      value,
    };
  }

  /** Resolve $variable references in params */
  private _resolveParams(params: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.startsWith("$")) {
        resolved[key] = vars[value] ?? value;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  private _ensureArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
  }

  private _asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    return {};
  }

  private _matchesFilter(event: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(filter)) {
      if (event[key] !== expected) return false;
    }
    return true;
  }

  private _setupTrigger(proc: ProcedureDefinition): void {
    if (proc.trigger.kind === "cron" && proc.trigger.cron) {
      // Simple interval-based cron (ms interval from cron expression)
      const intervalMs = this._parseCronToMs(proc.trigger.cron);
      if (intervalMs > 0) {
        const timer = setInterval(() => {
          this._execute(proc).catch(err => this._log(`cron error for ${proc.name}: ${err}`));
        }, intervalMs);
        this.cronTimers.set(proc.name, timer);
      }
    }
  }

  private _teardownTrigger(proc: ProcedureDefinition): void {
    const timer = this.cronTimers.get(proc.name);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(proc.name);
    }
  }

  private _parseCronToMs(expr: string): number {
    // Simple cron shortcuts: "1h", "30m", "1d", "6h"
    const match = expr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return 0;
    const val = parseInt(match[1]);
    switch (match[2]) {
      case "s": return val * 1000;
      case "m": return val * 60_000;
      case "h": return val * 3_600_000;
      case "d": return val * 86_400_000;
      default: return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Export / Import
  // --------------------------------------------------------------------------

  /**
   * Export all (or a filtered subset of) procedures as a structured JSON blob.
   * Suitable for backup and cross-instance migration.
   */
  exportProcedures(filter?: { names?: string[] }): ProcedureExport {
    let procs = this.list();
    if (filter?.names?.length) {
      const nameSet = new Set(filter.names);
      procs = procs.filter(p => nameSet.has(p.name));
    }
    return {
      version: "1.0.0",
      exported_at: Date.now(),
      procedure_count: procs.length,
      procedures: procs,
    };
  }

  /**
   * Import procedures from a `ProcedureExport` or a bare array.
   *
   * Conflict resolution:
   *  - `skip`      — leave the existing procedure unchanged (default)
   *  - `overwrite` — replace the existing procedure, resetting stats
   *  - `merge`     — update definition but preserve stats and created_at
   */
  async importProcedures(
    procedures: ProcedureDefinition[],
    opts: { conflict?: "skip" | "overwrite" | "merge" } = {},
  ): Promise<ImportResult> {
    const conflict = opts.conflict ?? "skip";
    let imported = 0;
    let skipped = 0;
    let overwritten = 0;
    const errors: string[] = [];

    for (const proc of procedures) {
      try {
        const existing = this.procedures.get(proc.name);

        if (existing) {
          if (conflict === "skip") {
            skipped++;
            continue;
          }

          if (conflict === "overwrite") {
            this._teardownTrigger(existing);
            const reset: ProcedureDefinition = {
              ...proc,
              stats: { run_count: 0, error_count: 0 },
              updated_at: Date.now(),
            };
            this.procedures.set(proc.name, reset);
            this._setupTrigger(reset);
            const embedding = await this.embed(`procedure: ${reset.name} — ${reset.description ?? ""}`);
            await this.db.store(JSON.stringify(reset), embedding, {
              tags: ["procedure", `proc:${reset.name}`],
              category: PROCEDURE_CATEGORY,
              source: "procedure-engine",
            });
            overwritten++;
            continue;
          }

          if (conflict === "merge") {
            this._teardownTrigger(existing);
            const merged: ProcedureDefinition = {
              ...proc,
              id: existing.id,
              created_at: existing.created_at,
              stats: existing.stats,
              version: existing.version + 1,
              updated_at: Date.now(),
            };
            this.procedures.set(proc.name, merged);
            this._setupTrigger(merged);
            const embedding = await this.embed(`procedure: ${merged.name} — ${merged.description ?? ""}`);
            await this.db.store(JSON.stringify(merged), embedding, {
              tags: ["procedure", `proc:${merged.name}`],
              category: PROCEDURE_CATEGORY,
              source: "procedure-engine",
            });
            overwritten++;
            continue;
          }
        }

        // New procedure — use the standard create path
        await this.create({
          name: proc.name,
          description: proc.description,
          trigger: proc.trigger,
          steps: proc.steps,
          created_by: proc.created_by ?? "import",
        });
        imported++;
      } catch (err) {
        errors.push(`${proc.name}: ${String(err)}`);
      }
    }

    this._log(`import complete: ${imported} imported, ${skipped} skipped, ${overwritten} overwritten, ${errors.length} errors`);
    return { imported, skipped, overwritten, errors };
  }

  // --------------------------------------------------------------------------
  // Bundle management
  // --------------------------------------------------------------------------

  /**
   * Create a named, versioned bundle from existing procedures and persist it to DB.
   */
  async createBundle(opts: {
    name: string;
    version?: string;
    description?: string;
    procedureNames: string[];
    tags?: string[];
    requires?: string[];
  }): Promise<ProcedureBundle> {
    if (!opts.name) throw new Error("bundle name is required");
    if (!opts.procedureNames?.length) throw new Error("procedureNames must not be empty");

    const procs = opts.procedureNames.map(n => {
      const p = this.procedures.get(n);
      if (!p) throw new Error(`procedure "${n}" not found`);
      return p;
    });

    const bundle: ProcedureBundle = {
      name: opts.name,
      version: opts.version ?? "1.0.0",
      description: opts.description,
      requires: opts.requires,
      procedures: procs,
      tags: opts.tags,
      created_at: Date.now(),
    };

    const embedding = await this.embed(`bundle: ${bundle.name} — ${bundle.description ?? ""}`);
    await this.db.store(JSON.stringify(bundle), embedding, {
      tags: ["procedure-bundle", `bundle:${bundle.name}`, ...(bundle.tags ?? [])],
      category: BUNDLE_CATEGORY,
      source: "procedure-engine",
    });

    this._log(`created bundle: ${bundle.name} (${procs.length} procedures)`);
    return bundle;
  }

  /**
   * List all stored procedure bundles.
   */
  async listBundles(): Promise<ProcedureBundle[]> {
    try {
      const results = await this.db.searchText("bundle:", { limit: 200, category: BUNDLE_CATEGORY });
      const bundles: ProcedureBundle[] = [];
      for (const item of results) {
        try {
          const bundle = JSON.parse(item.content) as ProcedureBundle;
          if (bundle.name && Array.isArray(bundle.procedures)) {
            bundles.push(bundle);
          }
        } catch { /* skip malformed */ }
      }
      return bundles;
    } catch (err) {
      this._log(`failed to list bundles: ${err}`);
      return [];
    }
  }

  /**
   * Install all procedures contained in a bundle.
   * Accepts a full `ProcedureBundle` object (e.g. one received via `listBundles`
   * or passed in from another instance).
   */
  async installBundle(bundle: ProcedureBundle, opts?: { conflict?: "skip" | "overwrite" | "merge" }): Promise<ImportResult> {
    if (!bundle?.procedures?.length) throw new Error("bundle contains no procedures");
    this._log(`installing bundle: ${bundle.name} (${bundle.procedures.length} procedures)`);
    return this.importProcedures(bundle.procedures, opts ?? {});
  }

  private _log(msg: string): void {
    if (this.debug) console.log(`[procedures] ${msg}`);
    else console.log(`[procedures] ${msg}`);
  }

  /** Cleanup on shutdown */
  destroy(): void {
    for (const timer of this.cronTimers.values()) clearInterval(timer);
    this.cronTimers.clear();
  }
}
