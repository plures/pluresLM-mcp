import fs from "node:fs/promises";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MemoryDB } from "@plures/superlocalmemory/db";
import { DualEmbeddings } from "@plures/superlocalmemory/embeddings";

import { loadConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

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

async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
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
  await ensureParentDir(config.dbPath);

  const embeddings = new DualEmbeddings(
    {
      openaiKey: config.openaiApiKey,
      // Keep dimension consistent with the plugin defaults; this impacts DB embedding storage.
      dimension: 1536,
      debug: config.debug,
    },
    config.debug
      ? {
          info: (msg: string) => process.stderr.write(`[superlocalmemory-mcp] ${msg}\n`),
          warn: (msg: string) => process.stderr.write(`[superlocalmemory-mcp] WARN: ${msg}\n`),
        }
      : undefined,
  );

  const db = new MemoryDB(config.dbPath, embeddings.dimension);

  const server = new Server(
    { name: "superlocalmemory-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Persistent local vector memory backed by SQLite. Use memory_store to save, memory_search to recall, and memory_index to ingest a codebase.",
    },
  );

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "memory_store",
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
          name: "memory_search",
          description: "Semantic search across memories.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query." },
              limit: { type: "number", description: "Max results (default 5)." },
              minScore: { type: "number", description: "Minimum cosine similarity score (default 0.3)." },
            },
            required: ["query"],
          },
        },
        {
          name: "memory_forget",
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
          name: "memory_profile",
          description: "Get the stored user profile summary (if any).",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "memory_index",
          description:
            "Index a project directory by storing file contents as memories (local only). Skips common large/irrelevant folders.",
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
          name: "memory_stats",
          description: "Get memory database statistics.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as JsonObject;

    try {
      if (name === "memory_store") {
        const content = String(args.content ?? "").trim();
        if (!content) throw new McpError(ErrorCode.InvalidParams, "content is required");

        const tags = asStringArray(args.tags) ?? [];
        const category = args.category !== undefined ? String(args.category) : undefined;
        const source = args.source !== undefined ? String(args.source) : "";

        const embedding = await embeddings.embed(content);
        const stored = await db.store(content, embedding, { tags, category, source });
        db.incrementCaptureCount();

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

      if (name === "memory_search") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");

        const limit = args.limit !== undefined ? Number(args.limit) : 5;
        const minScore = args.minScore !== undefined ? Number(args.minScore) : 0.3;

        const qvec = await embeddings.embed(query);
        const results = await db.vectorSearch(qvec, limit, minScore);

        return textResult({
          query,
          results: results.map((r: { entry: { id: string; content: string; created_at: number; source: string; tags: string[]; category: string }; score: number }) => ({
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

      if (name === "memory_forget") {
        const id = args.id !== undefined ? String(args.id) : undefined;
        const query = args.query !== undefined ? String(args.query).trim() : undefined;
        const threshold = args.threshold !== undefined ? Number(args.threshold) : 0.8;

        if (id) {
          db.delete(id);
          return textResult({ deleted: 1, mode: "id", id });
        }

        if (query) {
          const qvec = await embeddings.embed(query);
          const deleted = await db.deleteByQuery(qvec, threshold);
          return textResult({ deleted, mode: "query", query, threshold });
        }

        throw new McpError(ErrorCode.InvalidParams, "Provide either id or query");
      }

      if (name === "memory_profile") {
        const profile = db.getProfile();
        return textResult({ profile });
      }

      if (name === "memory_stats") {
        return textResult(db.stats());
      }

      if (name === "memory_index") {
        const directory = String(args.directory ?? "");
        if (!directory) throw new McpError(ErrorCode.InvalidParams, "directory is required");

        const maxFiles = args.maxFiles !== undefined ? Number(args.maxFiles) : 500;
        const maxBytesPerFile = args.maxBytesPerFile !== undefined ? Number(args.maxBytesPerFile) : 200_000;
        const category = args.category !== undefined ? String(args.category) : "project-context";
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
          uri: "memory://profile",
          name: "profile",
          description: "User profile summary (if available).",
          mimeType: "application/json",
        },
        {
          uri: "memory://recent",
          name: "recent",
          description: "Recent memory contents (last 20).",
          mimeType: "text/markdown",
        },
        {
          uri: "memory://stats",
          name: "stats",
          description: "Memory database statistics.",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "memory://profile") {
      const profile = db.getProfile();
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

    if (uri === "memory://stats") {
      const stats = db.stats();
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

    if (uri === "memory://recent") {
      const items = db.getAllContent(20);
      const md = [
        "# Recent memories",
        "",
        ...items.map((c: string, i: number) => `## ${i + 1}\n\n${c}`),
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

  const transport = new StdioServerTransport();

  const shutdown = async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(transport);
}
