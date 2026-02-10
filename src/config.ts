import os from "node:os";
import path from "node:path";

export interface McpConfig {
  dbPath: string;
  openaiApiKey: string;
  debug: boolean;
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const dbPath = expandHome(env.SUPERLOCALMEMORY_DB_PATH ?? "~/.superlocalmemory/mcp.db");
  const openaiApiKey = env.OPENAI_API_KEY ?? "";
  const debug = (env.SUPERLOCALMEMORY_DEBUG ?? "").toLowerCase() === "true";

  if (!openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is required (used for embeddings). Set OPENAI_API_KEY in the MCP server environment.",
    );
  }

  return { dbPath, openaiApiKey, debug };
}
