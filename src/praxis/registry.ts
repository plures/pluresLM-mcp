/**
 * Praxis registry & engine initialization for PluresLM MCP.
 *
 * Registers all four domain modules (tool-authorization,
 * request-validation, operation-routing, session-management)
 * and exposes a factory for creating a pre-configured engine.
 */

import {
  PraxisRegistry,
  createPraxisEngine,
  type LogicEngine,
} from '@plures/praxis';

import type { PluresLmContext, TransportMode } from './context.js';
import { toolAuthorizationModule } from './modules/tool-authorization.js';
import { requestValidationModule } from './modules/request-validation.js';
import { operationRoutingModule }  from './modules/operation-routing.js';
import { sessionManagementModule } from './modules/session-management.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Build a PraxisRegistry with all PluresLM modules registered.
 */
export function createPluresLmRegistry(): PraxisRegistry<PluresLmContext> {
  const registry = new PraxisRegistry<PluresLmContext>();

  registry.registerModule(toolAuthorizationModule);
  registry.registerModule(requestValidationModule);
  registry.registerModule(operationRoutingModule);
  registry.registerModule(sessionManagementModule);

  return registry;
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export interface PluresLmEngineOptions {
  transport: TransportMode;
  hasApiKey: boolean;
  debug: boolean;
  /** Override the default 60 req/min rate limit. */
  maxRequestsPerMinute?: number;
}

/**
 * Create a fully initialised Praxis LogicEngine for PluresLM.
 *
 * The returned engine is ready to process `TOOL_REQUEST` and
 * `SESSION_CHECK` events via `engine.step()`.
 */
export function createPluresLmEngine(
  opts: PluresLmEngineOptions,
): LogicEngine<PluresLmContext> {
  const registry = createPluresLmRegistry();
  const now = Date.now();

  const initialContext: PluresLmContext = {
    session: {
      id: '',
      state: 'connected',
      connectedAt: now,
      lastActiveAt: now,
      transport: opts.transport,
      requestCount: 0,
    },
    request: {
      toolName: '',
      args: {},
      timestamp: now,
    },
    rateLimit: {
      windowStart: now,
      requestsInWindow: 0,
      maxRequestsPerMinute: opts.maxRequestsPerMinute ?? 60,
    },
    config: {
      transport: opts.transport,
      hasApiKey: opts.hasApiKey,
      debug: opts.debug,
    },
  };

  return createPraxisEngine<PluresLmContext>({
    registry,
    initialContext,
    factDedup: 'last-write-wins',
    maxFacts: 500,
  });
}

export { type LogicEngine };
