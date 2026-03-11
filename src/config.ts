import os from "node:os";
import path from "node:path";

export interface McpConfig {
  // PluresDB configuration (replaces dbPath)
  pluresDbTopic: string;
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
  if (p.startsWith("~/") return path.join(os.homedir(), p.slice(2));
  return p;
}

function validateTopicKey(topic: string): boolean {
  // PluresDB topic keys should be 64-char hex strings (32 bytes)
  return /^[0-9a-f]{64}$/i.test(topic);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  // PluresDB topic (required)
  const pluresDbTopic = env.PLURES_DB_TOPIC;
  if (!pluresDbTopic) {
    throw new Error("PLURES_DB_TOPIC environment variable is required (64-char hex string)");
  }
  if (!validateTopicKey(pluresDbTopic)) {
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