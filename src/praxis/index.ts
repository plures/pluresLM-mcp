/**
 * @module praxis
 *
 * Re-exports the PluresLM Praxis integration surface:
 *
 * - Context types
 * - Domain modules (tool-authorization, request-validation, operation-routing, session-management)
 * - Registry & engine factory
 */

// Context types
export type {
  PluresLmContext,
  SessionState,
  TransportMode,
  ToolCategory,
  RequestContext,
  SessionContext,
  RateLimitContext,
} from './context.js';

// Modules
export { toolAuthorizationModule, TOOL_CATEGORIES } from './modules/tool-authorization.js';
export { requestValidationModule } from './modules/request-validation.js';
export { operationRoutingModule, ROUTE_TABLE } from './modules/operation-routing.js';
export type { OperationKind } from './modules/operation-routing.js';
export { sessionManagementModule, IDLE_TIMEOUT_MS, RATE_LIMIT_WINDOW_MS } from './modules/session-management.js';

// Registry & engine
export {
  createPluresLmRegistry,
  createPluresLmEngine,
  type PluresLmEngineOptions,
} from './registry.js';
