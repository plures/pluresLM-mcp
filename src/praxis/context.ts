/**
 * Praxis context type for the PluresLM MCP server.
 *
 * Captures the domain state that Praxis rules evaluate against:
 * session lifecycle, request metadata, rate-limit counters, and
 * server configuration flags.
 */

/** Possible states in the session lifecycle. */
export type SessionState = 'connected' | 'active' | 'idle' | 'expired';

/** Transport modes supported by the MCP server. */
export type TransportMode = 'stdio' | 'sse' | 'http';

/** Categories an MCP tool belongs to for authorization grouping. */
export type ToolCategory =
  | 'core-memory'
  | 'search'
  | 'maintenance'
  | 'export-import'
  | 'procedures'
  | 'status'
  | 'indexing';

/** Lightweight description of the current in-flight request. */
export interface RequestContext {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

/** Session tracking information. */
export interface SessionContext {
  id: string;
  state: SessionState;
  connectedAt: number;
  lastActiveAt: number;
  transport: TransportMode;
  requestCount: number;
}

/** Rate-limit counters. */
export interface RateLimitContext {
  windowStart: number;
  requestsInWindow: number;
  maxRequestsPerMinute: number;
}

/**
 * Top-level Praxis context threaded through every rule and constraint
 * in the PluresLM MCP Praxis engine.
 */
export interface PluresLmContext {
  session: SessionContext;
  request: RequestContext;
  rateLimit: RateLimitContext;
  config: {
    transport: TransportMode;
    hasApiKey: boolean;
    debug: boolean;
  };
}
