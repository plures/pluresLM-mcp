import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MemoryDB, type MemoryEntry } from "./db/memory.js";
import { createEmbeddings } from "./embeddings/index.js";

import { loadConfig } from "./config.js";
import { ProcedureEngine, type ProcedureStep, type ProcedureTrigger } from "./procedures.js";
import { createPluresLmEngine } from "./praxis/index.js";

type JsonObject = Record<string, unknown>;

type MemoryBundle = { metadata: { memory_count: number }; memories: MemoryEntry[] };
type MemoryPack = { name: string; memories: MemoryEntry[] };

function textResult(toolResult: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2),
      },
    ],
    toolResult,
  };
}

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new McpError(ErrorCode.InvalidParams, "Expected an array");
  return v.map((x) => String(x));
}

async function* walkDir(root: string, opts?: { ignore?: string[] }): AsyncGenerator<string> {
  const ignore = new Set(opts?.ignore ?? []);

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const ent of entries) {
    if (ignore.has(ent.name)) continue;
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) {
      yield* walkDir(p, opts);
    } else if (ent.isFile()) {
      yield p;
    }
  }
}

function shouldIndexFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith(".")) return false;
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".md",
    ".txt",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".yml",
    ".yaml",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".swift",
    ".rb",
    ".php",
    ".toml",
    ".ini",
  ].includes(ext);
}

export async function startServer(): Promise<void> {
  const config = loadConfig();

  // Create embeddings provider (defaults to Transformers.js, optional OpenAI)
  const embeddings = await createEmbeddings({
    openaiApiKey: config.openaiApiKey,
    openaiModel: config.openaiModel,
    debug: config.debug,
  });

  // Connect to PluresDB (replaces SQLite)
  const db = new MemoryDB({ topic: config.pluresDbTopic, secret: config.pluresDbSecret, dbPath: config.pluresDbPath, dimension: embeddings.dimension });
  await db.connect();

  // Initialize procedure engine
  const procedures = new ProcedureEngine({
    db: Object.assign(db, {
      listMemories: async (opts?: { limit?: number; category?: string }) => {
        return db.list({ limit: opts?.limit ?? 200, category: opts?.category });
      },
    }),
    embed: async (text: string) => embeddings.embed(text),
    onCue: async (name, payload) => {
      // Fire on_cue procedures
      await procedures.fireEvent("on_cue", { cue: name, ...payload });
    },
    debug: true,
  });
  await procedures.loadFromDb();

  // Praxis logic engine — declarative rules for authorization, validation, routing
  const praxisEngine = createPluresLmEngine({
    transport: config.transport,
    hasApiKey: !!process.env.MCP_API_KEY,
    debug: config.debug,
  });

  function createMcpServer() {
  const server = new Server(
    { name: "pluresLM-mcp", version: "2.5.1" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Persistent distributed vector memory backed by PluresDB. Use pluresLM_store to save, pluresLM_search to recall, and pluresLM_index to ingest a codebase. Supports P2P sync across devices.",
    },
  );

  // ---------------------------------------------------------------------------
  // Tools (Updated names to match PluresLM v2.0 convention)
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "pluresLM_store",
          description: "Store a memory (content) with optional tags and category.",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string", description: "The memory text to store." },
              tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
              category: { type: "string", description: "Optional category (e.g., decision, preference, project)." },
              source: { type: "string", description: "Optional source label." },
            },
            required: ["content"],
          },
        },
        {
          name: "pluresLM_search",
          description: "Semantic search across memories.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query." },
              limit: { type: "number", description: "Max results (default 5)." },
              minScore: { type: "number", description: "Minimum cosine similarity score (default 0.3)." },
              format: { type: "string", enum: ["compact", "verbose"], description: "Result format (default: compact). Compact returns dense JSONL assertions; verbose returns full metadata." },
            },
            required: ["query"],
          },
        },
        {
          name: "pluresLM_forget",
          description: "Delete memories by exact id OR by semantic query.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Memory ID (UUID) to delete." },
              query: { type: "string", description: "Semantic query to match for deletion." },
              threshold: { type: "number", description: "Similarity threshold (default 0.8) when deleting by query." },
            },
          },
        },
        {
          name: "pluresLM_profile",
          description: "Get the stored user profile summary (if any).",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_index",
          description:
            "Index a project directory by storing file contents as memories. Skips common large/irrelevant folders.",
          inputSchema: {
            type: "object",
            properties: {
              directory: { type: "string", description: "Directory path to index." },
              maxFiles: { type: "number", description: "Safety cap on number of files indexed (default 500)." },
              maxBytesPerFile: { type: "number", description: "Max bytes per file (default 200000)." },
              category: { type: "string", description: "Category to store under (default project-context)." },
              tags: { type: "array", items: { type: "string" }, description: "Extra tags applied to each indexed file." },
            },
            required: ["directory"],
          },
        },
        {
          name: "pluresLM_status",
          description: "Get memory database statistics and sync status.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_sync_status",
          description: "Get P2P sync status (peer count, connectivity).",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_list",
          description: "List memories with pagination and filtering.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max results (default 10)." },
              offset: { type: "number", description: "Skip offset (default 0)." },
              category: { type: "string", description: "Filter by category." },
              tags: { type: "array", items: { type: "string" }, description: "Filter by tags." },
              sortBy: { type: "string", enum: ["created_at"], description: "Sort field (default created_at)." },
              sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default desc)." },
            },
          },
        },
        {
          name: "pluresLM_get",
          description: "Get memory by ID.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Memory ID." },
            },
            required: ["id"],
          },
        },
        {
          name: "pluresLM_update",
          description: "Update memory by ID.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Memory ID." },
              content: { type: "string", description: "New content." },
              tags: { type: "array", items: { type: "string" }, description: "New tags." },
              category: { type: "string", description: "New category." },
            },
            required: ["id"],
          },
        },
        {
          name: "pluresLM_search_text",
          description: "Text search (non-semantic) across memories.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Text search query." },
              limit: { type: "number", description: "Max results (default 10)." },
              caseSensitive: { type: "boolean", description: "Case sensitive search (default false)." },
              wholeWords: { type: "boolean", description: "Match whole words only (default false)." },
              category: { type: "string", description: "Filter by category." },
            },
            required: ["query"],
          },
        },
        {
          name: "pluresLM_consolidate",
          description: "Find and remove duplicate memories.",
          inputSchema: {
            type: "object",
            properties: {
              similarityThreshold: { type: "number", description: "Similarity threshold (default 0.95)." },
              dryRun: { type: "boolean", description: "Preview only, don't delete (default true)." },
            },
          },
        },
        {
          name: "pluresLM_find_stale",
          description: "Find memories not accessed recently.",
          inputSchema: {
            type: "object",
            properties: {
              days: { type: "number", description: "Days threshold (default 30)." },
              limit: { type: "number", description: "Max results (default 10)." },
            },
          },
        },
        {
          name: "pluresLM_world_state",
          description: "Get memory system summary and world state.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_daily_summary",
          description: "Get daily summary for a specific date.",
          inputSchema: {
            type: "object",
            properties: {
              date: { type: "string", description: "Date in YYYY-MM-DD format." },
            },
            required: ["date"],
          },
        },
        {
          name: "pluresLM_health",
          description: "MCP service health check.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_export_bundle",
          description: "Export all memories as a bundle.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_restore_bundle",
          description: "Restore memories from a bundle.",
          inputSchema: {
            type: "object",
            properties: {
              bundle: { 
                type: "object", 
                description: "Bundle object with metadata and memories.",
                properties: {
                  metadata: { type: "object" },
                  memories: { type: "array" },
                },
                required: ["metadata", "memories"],
              },
            },
            required: ["bundle"],
          },
        },
        {
          name: "pluresLM_export_pack",
          description: "Export a filtered subset of memories as a pack.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Pack name." },
              category: { type: "string", description: "Filter by category." },
              tags: { type: "array", items: { type: "string" }, description: "Filter by tags." },
              dateStart: { type: "number", description: "Start timestamp." },
              dateEnd: { type: "number", description: "End timestamp." },
              limit: { type: "number", description: "Max memories to include." },
            },
            required: ["name"],
          },
        },
        {
          name: "pluresLM_import_pack",
          description: "Import memories from a pack.",
          inputSchema: {
            type: "object",
            properties: {
              pack: {
                type: "object",
                description: "Pack object with name and memories.",
                properties: {
                  name: { type: "string" },
                  memories: { type: "array" },
                },
                required: ["name", "memories"],
              },
            },
            required: ["pack"],
          },
        },
        {
          name: "pluresLM_list_packs",
          description: "List available memory packs.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_uninstall_pack",
          description: "Remove a memory pack.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Pack name to remove." },
            },
            required: ["name"],
          },
        },
        {
          name: "pluresLM_query",
          description: "Advanced DSL query processor.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "DSL query (e.g., 'filter(category == \"decision\") |> sort(by: created_at, dir: desc) |> limit(5)')." },
            },
            required: ["query"],
          },
        },
        {
          name: "pluresLM_query_dsl",
          description: "Advanced DSL query processor.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "DSL query (e.g., 'filter(category == \"decision\") |> sort(by: created_at, dir: desc) |> limit(5)')." },
            },
            required: ["query"],
          },
        },

        // ---- Procedures ----
        {
          name: "pluresLM_create_procedure",
          description: "Create a stored procedure — a named, reusable pipeline of memory operations that runs on triggers or on demand. Steps: search, search_text, filter, sort, limit, merge (RRF), store, update, delete, transform (structured/fused), cue, parallel, conditional, assign, emit. Triggers: manual, after_store, before_search, on_cue, cron (e.g. '1h', '6h', '1d'). Variables: $input (trigger event), $pipeline (step output chain). Use 'as' on a step to save its result to a named variable for later use.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Unique procedure name" },
              description: { type: "string", description: "What this procedure does" },
              trigger: {
                type: "object",
                description: "When to run: { kind: 'manual'|'after_store'|'before_search'|'on_cue'|'cron', cron?: '1h', filter?: { category: 'x' }, cue?: 'name' }",
                properties: {
                  kind: { type: "string" },
                  cron: { type: "string" },
                  filter: { type: "object" },
                  cue: { type: "string" },
                },
                required: ["kind"],
              },
              steps: {
                type: "array",
                description: "Ordered steps to execute. Each: { kind, params, as? }",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string" },
                    params: { type: "object" },
                    as: { type: "string" },
                  },
                  required: ["kind", "params"],
                },
              },
            },
            required: ["name", "trigger", "steps"],
          },
        },
        {
          name: "pluresLM_run_procedure",
          description: "Run a stored procedure by name, optionally passing input context.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Procedure name" },
              context: { type: "object", description: "Input context available as $input in steps" },
            },
            required: ["name"],
          },
        },
        {
          name: "pluresLM_list_procedures",
          description: "List all stored procedures with their triggers, stats, and enabled status.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "pluresLM_update_procedure",
          description: "Update a stored procedure's steps, trigger, description, or enabled status.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Procedure name to update" },
              description: { type: "string" },
              trigger: { type: "object" },
              steps: { type: "array", items: { type: "object" } },
              enabled: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        {
          name: "pluresLM_delete_procedure",
          description: "Delete a stored procedure by name.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        {
          name: "pluresLM_autolink",
          description: "Trigger automatic relationship discovery between memories.",
          inputSchema: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["all", "incremental", "memory"] },
              target: { type: "string", description: "Memory UUID when mode=memory" },
            },
            required: ["mode"],
          },
        },
        {
          name: "pluresLM_graph_neighbors",
          description: "Find memories related to a given memory via vector similarity.",
          inputSchema: {
            type: "object",
            properties: {
              memoryId: { type: "string" },
              depth: { type: "number", description: "Number of neighbors to return (default 5)" },
            },
            required: ["memoryId"],
          },
        },
        {
          name: "pluresLM_graph_insights",
          description: "Analyze memory relationship patterns — category distribution and stats.",
          inputSchema: {
            type: "object",
            properties: {
              timespan: { type: "string", description: "Timespan label e.g. '7d', '30d'" },
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as JsonObject;

    // --- Praxis: update context and step the logic engine ---
    praxisEngine.updateContext((ctx: any) => ({
      ...ctx,
      request: { toolName: name, args, timestamp: Date.now() },
      session: { ...ctx.session, lastActiveAt: Date.now(), requestCount: ctx.session.requestCount + 1 },
      rateLimit: {
        ...ctx.rateLimit,
        requestsInWindow: ctx.rateLimit.requestsInWindow + 1,
      },
    }));

    const praxisResult = praxisEngine.step([{ tag: 'TOOL_REQUEST', payload: { toolName: name, args, timestamp: Date.now() } }]);

    // Surface constraint violations as MCP errors
    for (const diag of praxisResult.diagnostics) {
      if (diag.kind === 'constraint-violation') {
        throw new McpError(ErrorCode.InvalidParams, diag.message);
      }
    }

    try {
      if (name === "pluresLM_store") {
        const content = String(args.content ?? "").trim();
        if (!content) throw new McpError(ErrorCode.InvalidParams, "content is required");

        const tags = asStringArray(args.tags) ?? [];
        const category = args.category != null ? String(args.category) : undefined;
        const source = args.source != null ? String(args.source) : "";

        const embedding = await embeddings.embed(content);
        const stored = await db.store(content, embedding, { tags, category, source });
        await db.incrementCaptureCount();

        // Fire after_store procedures (async, don't block the response)
        procedures.fireEvent("after_store", {
          id: stored.entry.id,
          content,
          tags,
          category,
          source,
          isDuplicate: stored.isDuplicate,
        }).catch(err => console.error("[procedures] after_store error:", err));

        return textResult({
          id: stored.entry.id,
          isDuplicate: stored.isDuplicate,
          updatedId: stored.updatedId,
          created_at: stored.entry.created_at,
          tags: stored.entry.tags,
          category: stored.entry.category,
          source: stored.entry.source,
        });
      }

      if (name === "pluresLM_search") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");

        const limit = args.limit !== undefined ? Number(args.limit) : 5;
        const minScore = args.minScore !== undefined ? Number(args.minScore) : 0.3;
        const format = args.format === "verbose" ? "verbose" : "compact";

        const qvec = await embeddings.embed(query);
        const results = await db.vectorSearch(qvec, limit, minScore);

        if (format === "verbose") {
          return textResult({
            query,
            results: results.map((r) => ({
              id: r.entry.id,
              content: r.entry.content,
              score: r.score,
              created_at: r.entry.created_at,
              source: r.entry.source,
              tags: r.entry.tags,
              category: r.entry.category,
            })),
          });
        }

        // Compact: dense JSONL — one assertion per line, ~3x token savings
        const lines = results.map((r) => {
          const o: Record<string, unknown> = { fact: r.entry.content };
          if (r.entry.category && r.entry.category !== "conversation") o.cat = r.entry.category;
          o.score = Math.round(r.score * 1000) / 1000;
          if (r.entry.tags?.length) o.tags = r.entry.tags;
          if (r.entry.created_at) {
            const d = new Date(r.entry.created_at);
            if (!isNaN(d.getTime())) o.when = d.toISOString().slice(0, 10);
          }
          return JSON.stringify(o);
        });
        return textResult(lines.join("\n"));
      }

      if (name === "pluresLM_forget") {
        const id = args.id != null ? String(args.id) : undefined;
        const query = args.query != null ? String(args.query).trim() : undefined;
        const threshold = args.threshold !== undefined ? Number(args.threshold) : 0.8;

        if (id) {
          const deleted = await db.delete(id);
          return textResult({ deleted: deleted ? 1 : 0, mode: "id", id });
        }

        if (query) {
          const qvec = await embeddings.embed(query);
          const deleted = await db.deleteByQuery(qvec, threshold);
          return textResult({ deleted, mode: "query", query, threshold });
        }

        throw new McpError(ErrorCode.InvalidParams, "Provide either id or query");
      }

      if (name === "pluresLM_profile") {
        const profile = await db.getProfile();
        return textResult({ profile });
      }

      if (name === "pluresLM_status" || name === "pluresLM_sync_status") {
        const stats = await db.stats();
        return textResult(stats);
      }

      if (name === "pluresLM_index") {
        const directory = String(args.directory ?? "");
        if (!directory) throw new McpError(ErrorCode.InvalidParams, "directory is required");

        const maxFiles = args.maxFiles !== undefined ? Number(args.maxFiles) : 500;
        const maxBytesPerFile = args.maxBytesPerFile !== undefined ? Number(args.maxBytesPerFile) : 200_000;
        const category = args.category != null ? String(args.category) : "project-context";
        const extraTags = asStringArray(args.tags) ?? [];

        const root = path.resolve(directory);

        let indexed = 0;
        let skipped = 0;
        let errors = 0;

        for await (const filePath of walkDir(root, { ignore: ["node_modules", ".git", "dist", "build", ".next", "out", "coverage"] })) {
          if (indexed >= maxFiles) break;
          if (!shouldIndexFile(filePath)) {
            skipped++;
            continue;
          }

          try {
            const stat = await fs.stat(filePath);
            if (stat.size > maxBytesPerFile) {
              skipped++;
              continue;
            }

            const raw = await fs.readFile(filePath, "utf8");
            const rel = path.relative(root, filePath);

            // Keep embedding input bounded; include path header so retrieval is useful.
            const body = raw.length > 20_000 ? raw.slice(0, 20_000) + "\n\n[truncated]" : raw;
            const content = `File: ${rel}\n\n${body}`;

            const emb = await embeddings.embed(content);
            await db.store(content, emb, {
              source: `index:${root}`,
              category,
              tags: ["indexed", `path:${rel}`.replaceAll("\\", "/"), ...extraTags],
              // For indexing, be more aggressive about dedupe.
              dedupeThreshold: 0.98,
            });

            indexed++;
          } catch {
            errors++;
          }
        }

        return textResult({ directory: root, indexed, skipped, errors, maxFiles, maxBytesPerFile, category, tags: extraTags });
      }

      // New Sprint Log compatibility tools
      if (name === "pluresLM_list") {
        const limit = args.limit !== undefined ? Number(args.limit) : 10;
        const offset = args.offset !== undefined ? Number(args.offset) : 0;
        const category = args.category != null ? String(args.category) : undefined;
        const tags = asStringArray(args.tags);
        const sortBy = args.sortBy != null ? String(args.sortBy) as 'created_at' : 'created_at';
        const sortOrder = args.sortOrder != null ? String(args.sortOrder) as 'asc' | 'desc' : 'desc';

        const memories = await db.list({ limit, offset, category, tags, sortBy, sortOrder });
        return textResult({
          memories: memories.map(m => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            category: m.category,
            source: m.source,
            created_at: m.created_at,
          })),
          total: memories.length,
          limit,
          offset,
        });
      }

      if (name === "pluresLM_get") {
        const id = String(args.id ?? "");
        if (!id) throw new McpError(ErrorCode.InvalidParams, "id is required");

        const memory = await db.get(id);
        if (!memory) {
          throw new McpError(ErrorCode.InvalidParams, `Memory not found: ${id}`);
        }

        return textResult({
          memory: {
            id: memory.id,
            content: memory.content,
            tags: memory.tags,
            category: memory.category,
            source: memory.source,
            created_at: memory.created_at,
          }
        });
      }

      if (name === "pluresLM_update") {
        const id = String(args.id ?? "");
        if (!id) throw new McpError(ErrorCode.InvalidParams, "id is required");

        const updates: Record<string, unknown> = {};
        if (args.content !== undefined) updates.content = String(args.content);
        if (args.tags !== undefined) updates.tags = asStringArray(args.tags) ?? [];
        if (args.category !== undefined) updates.category = String(args.category);

        const success = await db.update(id, updates);
        if (!success) {
          throw new McpError(ErrorCode.InvalidParams, `Memory not found: ${id}`);
        }

        return textResult({ success: true, id, updated: Object.keys(updates) });
      }

      if (name === "pluresLM_search_text") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");

        const limit = args.limit !== undefined ? Number(args.limit) : 10;
        const caseSensitive = args.caseSensitive !== undefined ? Boolean(args.caseSensitive) : false;
        const wholeWords = args.wholeWords !== undefined ? Boolean(args.wholeWords) : false;
        const category = args.category != null ? String(args.category) : undefined;

        const results = await db.searchText(query, { limit, caseSensitive, wholeWords, category });

        return textResult({
          query,
          results: results.map(m => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            category: m.category,
            source: m.source,
            created_at: m.created_at,
          })),
        });
      }

      if (name === "pluresLM_consolidate") {
        const threshold = args.similarityThreshold !== undefined ? Number(args.similarityThreshold) : 0.95;
        const dryRun = args.dryRun !== undefined ? Boolean(args.dryRun) : true;

        const result = await db.consolidate(threshold, dryRun);
        return textResult(result);
      }

      if (name === "pluresLM_find_stale") {
        const days = args.days !== undefined ? Number(args.days) : 30;
        const limit = args.limit !== undefined ? Number(args.limit) : 10;

        const staleMemories = await db.findStale(days, limit);
        return textResult({
          daysThreshold: days,
          staleMemories: staleMemories.map(m => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            category: m.category,
            source: m.source,
            created_at: m.created_at,
            daysSinceCreated: Math.floor((Date.now() - m.created_at) / (24 * 60 * 60 * 1000)),
          })),
        });
      }

      if (name === "pluresLM_world_state") {
        const worldState = await db.getWorldState();
        return textResult(worldState);
      }

      if (name === "pluresLM_daily_summary") {
        const date = String(args.date ?? "");
        if (!date) throw new McpError(ErrorCode.InvalidParams, "date is required");

        const summary = await db.getDailySummary(date);
        return textResult(summary);
      }

      if (name === "pluresLM_health") {
        const health = await db.health();
        return textResult(health);
      }

      // Export/Import/Pack tools
      if (name === "pluresLM_export_bundle") {
        const bundle = await db.exportBundle();
        return textResult(bundle);
      }

      if (name === "pluresLM_restore_bundle") {
        const bundle = args.bundle;
        if (!bundle || typeof bundle !== "object") throw new McpError(ErrorCode.InvalidParams, "bundle is required");

        const result = await db.restoreBundle(bundle as MemoryBundle);
        return textResult(result);
      }

      if (name === "pluresLM_export_pack") {
        const name = String(args.name ?? "");
        if (!name) throw new McpError(ErrorCode.InvalidParams, "name is required");

        const options: { name: string; category?: string; tags?: string[]; dateRange?: { start: number; end: number }; limit?: number } = { name };
        if (args.category) options.category = String(args.category);
        if (args.tags) options.tags = asStringArray(args.tags);
        if (args.dateStart && args.dateEnd) {
          options.dateRange = {
            start: Number(args.dateStart),
            end: Number(args.dateEnd),
          };
        }
        if (args.limit) options.limit = Number(args.limit);

        const result = await db.exportPack(options);
        return textResult(result);
      }

      if (name === "pluresLM_import_pack") {
        const pack = args.pack;
        if (!pack || typeof pack !== "object") throw new McpError(ErrorCode.InvalidParams, "pack is required");

        const result = await db.importPack(pack as MemoryPack);
        return textResult(result);
      }

      if (name === "pluresLM_list_packs") {
        const packs = await db.listPacks();
        return textResult({ packs });
      }

      if (name === "pluresLM_uninstall_pack") {
        const name = String(args.name ?? "");
        if (!name) throw new McpError(ErrorCode.InvalidParams, "name is required");

        const success = await db.uninstallPack(name);
        return textResult({ success, pack: name });
      }

      if (name === "pluresLM_query" || name === "pluresLM_query_dsl") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");

        const nativeResult = db.query(query) as { nodes?: unknown[] } | undefined;
        const nodes = nativeResult?.nodes ?? [];
        const results = (Array.isArray(nodes) ? nodes : []).map((node) => {
          const record = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
          const data = record && "data" in record ? record.data : record;
          const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
          if (!("id" in raw) && "id" in record) {
            raw.id = record.id as string;
          }
          return {
            id: raw.id as string | undefined,
            content: raw.content as string | undefined,
            tags: (raw.tags as string[]) ?? [],
            category: raw.category as string | undefined,
            source: raw.source as string | undefined,
            created_at: raw.created_at as number | undefined,
          };
        });

        return textResult({ query, results });
      }

      // ---- Procedure tools ----

      if (name === "pluresLM_create_procedure") {
        const procName = String(args.name ?? "");
        const trigger = args.trigger as ProcedureTrigger;
        const steps = args.steps as ProcedureStep[];
        const description = args.description as string | undefined;
        const proc = await procedures.create({ name: procName, description, trigger, steps, created_by: "agent" });
        return textResult({ created: proc.name, id: proc.id, trigger: proc.trigger.kind, steps: proc.steps.length });
      }

      if (name === "pluresLM_run_procedure") {
        const procName = String(args.name ?? "");
        const context = (args.context ?? {}) as Record<string, unknown>;
        const result = await procedures.run(procName, context);
        return textResult(result);
      }

      if (name === "pluresLM_list_procedures") {
        const procs = procedures.list();
        return textResult({
          count: procs.length,
          procedures: procs.map(p => ({
            name: p.name,
            description: p.description,
            trigger: p.trigger,
            enabled: p.enabled,
            version: p.version,
            stats: p.stats,
          })),
        });
      }

      if (name === "pluresLM_update_procedure") {
        const procName = String(args.name ?? "");
        const patch: Partial<{
          description: string;
          trigger: ProcedureTrigger;
          steps: ProcedureStep[];
          enabled: boolean;
        }> = {};
        if (args.description !== undefined) patch.description = String(args.description);
        if (args.trigger !== undefined) patch.trigger = args.trigger as ProcedureTrigger;
        if (args.steps !== undefined) patch.steps = args.steps as ProcedureStep[];
        if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
        const updated = await procedures.update(procName, patch);
        return textResult({ updated: updated.name, version: updated.version });
      }

      if (name === "pluresLM_delete_procedure") {
        const procName = String(args.name ?? "");
        await procedures.remove(procName);
        return textResult({ deleted: procName });
      }

      // --- Graph / Autolink tools ---

      if (name === "pluresLM_autolink") {
        const mode = String(args.mode ?? "incremental");
        const BATCH_SIZE = 50;
        const MAX_LINKS = 200;
        let linked = 0;

        if (mode === "memory" && args.target) {
          const targetMem = await db.get(String(args.target));
          if (!targetMem?.embedding?.length) return textResult({ linked: 0, error: "memory not found or has no embedding" });
          const neighbors = await db.vectorSearch(targetMem.embedding, 5, 0.7);
          linked = neighbors.filter(n => n.entry.id !== String(args.target)).length;
          return textResult({ mode, linked, target: args.target });
        }

        const allMemories = await db.list({ limit: mode === "all" ? 5000 : BATCH_SIZE, sortBy: "created_at", sortOrder: "desc" });
        const relationships: Array<{from: string; to: string; score: number}> = [];

        for (const mem of allMemories) {
          if (linked >= MAX_LINKS) break;
          if (!mem?.embedding?.length) continue;
          try {
            const neighbors = await db.vectorSearch(mem.embedding, 3, 0.75);
            for (const n of neighbors) {
              if (n.entry.id === mem.id) continue;
              relationships.push({ from: mem.id, to: n.entry.id, score: n.score });
              linked++;
            }
          } catch { continue; }
        }

        return textResult({ mode, linked, sample: relationships.slice(0, 10) });
      }

      if (name === "pluresLM_graph_neighbors") {
        const memoryId = String(args.memoryId ?? "");
        const depth = Number(args.depth ?? 5);
        const mem = await db.get(memoryId);
        if (!mem?.embedding?.length) return textResult({ error: "memory not found or has no embedding" });
        const neighbors = await db.vectorSearch(mem.embedding, depth + 1, 0.5);
        const results = neighbors
          .filter(n => n.entry.id !== memoryId)
          .slice(0, depth)
          .map(n => ({ id: n.entry.id, content: n.entry.content?.slice(0, 200), score: n.score, category: n.entry.category }));
        return textResult({ memoryId, neighbors: results });
      }

      if (name === "pluresLM_graph_insights") {
        const stats = await db.stats();
        const allMemories = await db.list({ limit: 10000 });
        const categories: Record<string, number> = {};
        const tagCounts: Record<string, number> = {};
        let withEmbedding = 0;

        for (const mem of allMemories) {
          const cat = mem.category || "uncategorized";
          categories[cat] = (categories[cat] || 0) + 1;
          if (mem.embedding?.length) withEmbedding++;
          if (Array.isArray(mem.tags)) {
            for (const tag of mem.tags) {
              tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            }
          }
        }

        const topTags = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([tag, count]) => ({ tag, count }));

        return textResult({
          memoryCount: stats.memoryCount,
          withEmbedding,
          categories,
          topTags,
        });
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, String((err as Error)?.message ?? err));
    }
  });

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "pluresLM://profile",
          name: "profile",
          description: "User profile summary (if available).",
          mimeType: "application/json",
        },
        {
          uri: "pluresLM://recent",
          name: "recent",
          description: "Recent memory contents (last 20).",
          mimeType: "text/markdown",
        },
        {
          uri: "pluresLM://stats", 
          name: "stats",
          description: "Memory database statistics and P2P sync status.",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "pluresLM://profile") {
      const profile = await db.getProfile();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ profile }, null, 2),
          },
        ],
      };
    }

    if (uri === "pluresLM://stats") {
      const stats = await db.stats();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    if (uri === "pluresLM://recent") {
      const items = await db.getAllContent(20);
      const md = [
        "# Recent memories",
        "",
        ...items.map((c, i) => `## ${i + 1}\n\n${c}`),
      ].join("\n\n");

      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: md,
          },
        ],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown resource: ${uri}`);
  });

  // ---------------------------------------------------------------------------
  // Transport + lifecycle
  // ---------------------------------------------------------------------------

  return server;
  } // end createMcpServer

  const server = createMcpServer();
  let transport: StdioServerTransport | null;
  
  if (config.transport === 'sse' || config.transport === 'http') {
    const { createServer } = await import('node:http');
    const { randomUUID } = await import('node:crypto');

    // Multi-client: each session gets its own transport + server instance
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

    async function createSession(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
      const sessionTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const sessionServer = createMcpServer();
      await sessionServer.connect(sessionTransport);
      // Handle the init request — this sets the session ID
      await sessionTransport.handleRequest(req, res);
      const sid = sessionTransport.sessionId;
      if (sid) {
        sessions.set(sid, { transport: sessionTransport, server: sessionServer });
        sessionTransport.onclose = () => sessions.delete(sid);
      }
    }

    const apiKey = process.env.MCP_API_KEY;

    const httpServer = createServer(async (req, res) => {
      // Health endpoint (no auth required)
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          service: 'pluresLM-mcp',
          version: pkg?.version ?? 'unknown',
          dbPath: config.pluresDbPath,
          topic: config.pluresDbTopic,
          activeSessions: sessions.size,
        }));
        return;
      }

      // MCP endpoint
      if (req.url === '/mcp') {
        // API key check (if MCP_API_KEY is set)
        if (apiKey) {
          const provided = req.headers['x-api-key'] as string | undefined;
          if (provided !== apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized — invalid or missing x-api-key' }));
            return;
          }
        }
        try {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            await sessions.get(sessionId)!.transport.handleRequest(req, res);
          } else if (!sessionId) {
            // New session — create transport+server pair and handle init
            await createSession(req, res);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
          }
        } catch (err) {
          console.error('MCP request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found. Use POST /mcp for MCP or GET /health');
    });

    httpServer.listen(config.port, config.host, () => {
      console.error(`🚀 PluresLM MCP Server listening on http://${config.host}:${config.port}/mcp`);
      console.error(`   Health: http://${config.host}:${config.port}/health`);
      console.error(`   DB: ${config.pluresDbPath || config.pluresDbTopic}`);
    });

    transport = null; // HTTP mode — sessions manage their own transports
  } else {
    // Default stdio transport
    transport = new StdioServerTransport();
    console.error("🚀 PluresLM MCP Server starting with stdio transport");
    console.error(`   DB: ${config.pluresDbPath || config.pluresDbTopic}`);
  }

  const shutdown = async () => {
    try {
      if (transport) await transport.close();
    } catch (err) {
      console.error("Error closing transport:", err);
    }
    try {
      db.close();
    } catch (err) {
      console.error("Error closing database:", err);
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (transport) await server.connect(transport);
}