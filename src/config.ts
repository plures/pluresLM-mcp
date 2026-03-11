import os from "node:os";
import path from "node:path";

export interface McpConfig {
  // PluresDB configuration — either path-based or topic-based
  pluresDbPath?: string;        // Direct DB path (takes priority)
  pluresDbTopic?: string;       // Topic key → ~/.pluresdb/topics/${topic}
  pluresDbSecret?: string;
  
  // Transport configuration
  transport: 'stdio' | 'sse' | 'http';
  port?: number;
  host?: string;
  
  // Embedding configuration
  openaiApiKey?: string;
  openaiModel?: string;
  debug: boolean;
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function validateTopicKey(topic: string): boolean {
  // PluresDB topic keys should be 64-char hex strings (32 bytes)
  return /^[0-9a-f]{64}$/i.test(topic);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  // PluresDB path takes priority over topic
  const pluresDbPath = env.PLURES_DB_PATH ? expandHome(env.PLURES_DB_PATH) : undefined;
  const pluresDbTopic = env.PLURES_DB_TOPIC;

  if (!pluresDbPath && !pluresDbTopic) {
    throw new Error("Either PLURES_DB_PATH or PLURES_DB_TOPIC environment variable is required");
  }
  if (pluresDbTopic && !validateTopicKey(pluresDbTopic)) {
    throw new Error("PLURES_DB_TOPIC must be a valid 64-character hex string (32 bytes)");
  }

  const pluresDbSecret = env.PLURES_DB_SECRET;
  
  // Transport configuration
  const transport = (env.MCP_TRANSPORT as 'stdio' | 'sse' | 'http') || 'stdio';
  const port = env.PORT ? parseInt(env.PORT) : 3001;
  const host = env.HOST || '0.0.0.0';
  
  // Embedding configuration 
  const openaiApiKey = env.OPENAI_API_KEY;
  const openaiModel = env.OPENAI_EMBEDDING_MODEL;
  const debug = (env.PLURES_LM_DEBUG ?? "").toLowerCase() === "true";

  return { 
    pluresDbPath,
    pluresDbTopic, 
    pluresDbSecret,
    transport,
    port,
    host,
    openaiApiKey, 
    openaiModel, 
    debug 
  };
}