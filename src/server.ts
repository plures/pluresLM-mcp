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

import { MemoryDB } from "./db/memory.js";
import { createEmbeddings } from "./embeddings/index.js";

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
  const db = new MemoryDB(config.pluresDbTopic, config.pluresDbSecret, embeddings.dimension);
  await db.connect();

  const server = new Server(
    { name: "pluresLM-mcp", version: "2.0.0" },
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as JsonObject;

    try {
      if (name === "pluresLM_store") {
        const content = String(args.content ?? "").trim();
        if (!content) throw new McpError(ErrorCode.InvalidParams, "content is required");

        const tags = asStringArray(args.tags) ?? [];
        const category = args.category !== undefined ? String(args.category) : undefined;
        const source = args.source !== undefined ? String(args.source) : "";

        const embedding = await embeddings.embed(content);
        const stored = await db.store(content, embedding, { tags, category, source });
        await db.incrementCaptureCount();

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

        const qvec = await embeddings.embed(query);
        const results = await db.vectorSearch(qvec, limit, minScore);

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

      if (name === "pluresLM_forget") {
        const id = args.id !== undefined ? String(args.id) : undefined;
        const query = args.query !== undefined ? String(args.query).trim() : undefined;
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
  // Transport + lifecycle (CORRECTED: Simple HTTP with stdio fallback)
  // ---------------------------------------------------------------------------

  let transport;
  
  if (config.transport === 'sse' || config.transport === 'http') {
    // Create HTTP server that serves MCP over stdio-like interface
    const { createServer } = await import('node:http');
    
    const httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          service: 'pluresLM-mcp',
          version: '2.0.0',
          transport: 'http',
          topic: config.pluresDbTopic 
        }));
        return;
      }
      
      if (req.url === '/mcp' && req.method === 'POST') {
        // Handle MCP JSON-RPC over HTTP POST
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const request = JSON.parse(body);
            // This would need proper MCP request handling
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'MCP over HTTP POST not yet implemented' }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
      
      // Default response with usage instructions
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`PluresLM MCP Server v2.0.0

HTTP Endpoints:
- GET  /health - Health check
- POST /mcp    - MCP JSON-RPC (not yet implemented)

For full MCP support, use stdio transport:
PLURES_DB_TOPIC=${config.pluresDbTopic} node dist/index.js

Topic: ${config.pluresDbTopic}
Transport: ${config.transport}
`);
    });
    
    httpServer.listen(config.port, config.host, () => {
      console.error(`🚀 PluresLM MCP Server listening on http://${config.host}:${config.port}`);
      console.error(`   Health Check: http://${config.host}:${config.port}/health`);
      console.error(`   Topic: ${config.pluresDbTopic}`);
      console.error(`   Transport: HTTP (limited) - use stdio for full MCP support`);
    });
    
    // For now, still use stdio for actual MCP communication
    // HTTP mode provides health checks and future JSON-RPC endpoint
    transport = new StdioServerTransport();
  } else {
    // Default stdio transport
    transport = new StdioServerTransport();
    console.error("🚀 PluresLM MCP Server starting with stdio transport");
    console.error(`   Topic: ${config.pluresDbTopic}`);
  }

  const shutdown = async () => {
    try {
      await transport.close();
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

  await server.connect(transport);
}