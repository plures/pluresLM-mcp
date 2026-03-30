/**
 * operation-routing module
 *
 * Praxis rules that decide which backend operation handles a given
 * MCP tool call, and whether embeddings are required.  This replaces
 * the implicit if/else chain in the tool handler with an explicit,
 * auditable routing table expressed as declarative facts.
 */

import {
  defineModule,
  defineRule,
  defineContract,
  RuleResult,
  fact,
} from '@plures/praxis/core';

import type { PluresLmContext } from '../context.js';

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

/** Backend operation kinds that map to MemoryDB / ProcedureEngine methods. */
export type OperationKind =
  | 'embed-and-store'
  | 'embed-and-search'
  | 'embed-and-delete'
  | 'direct-read'
  | 'direct-write'
  | 'direct-delete'
  | 'listing'
  | 'stats'
  | 'export'
  | 'import'
  | 'procedure-exec'
  | 'procedure-mgmt'
  | 'indexing';

interface RouteEntry {
  operation: OperationKind;
  requiresEmbedding: boolean;
}

const ROUTE_TABLE: Record<string, RouteEntry> = {
  pluresLM_store:            { operation: 'embed-and-store',  requiresEmbedding: true  },
  pluresLM_search:           { operation: 'embed-and-search', requiresEmbedding: true  },
  pluresLM_forget:           { operation: 'embed-and-delete', requiresEmbedding: true  },
  pluresLM_get:              { operation: 'direct-read',      requiresEmbedding: false },
  pluresLM_update:           { operation: 'direct-write',     requiresEmbedding: false },
  pluresLM_list:             { operation: 'listing',          requiresEmbedding: false },
  pluresLM_search_text:      { operation: 'listing',          requiresEmbedding: false },
  pluresLM_query_dsl:        { operation: 'listing',          requiresEmbedding: false },
  pluresLM_index:            { operation: 'indexing',         requiresEmbedding: true  },
  pluresLM_profile:          { operation: 'stats',            requiresEmbedding: false },
  pluresLM_status:           { operation: 'stats',            requiresEmbedding: false },
  pluresLM_sync_status:      { operation: 'stats',            requiresEmbedding: false },
  pluresLM_health:           { operation: 'stats',            requiresEmbedding: false },
  pluresLM_world_state:      { operation: 'stats',            requiresEmbedding: false },
  pluresLM_daily_summary:    { operation: 'stats',            requiresEmbedding: false },
  pluresLM_consolidate:      { operation: 'listing',          requiresEmbedding: false },
  pluresLM_find_stale:       { operation: 'listing',          requiresEmbedding: false },
  pluresLM_export_bundle:    { operation: 'export',           requiresEmbedding: false },
  pluresLM_restore_bundle:   { operation: 'import',           requiresEmbedding: false },
  pluresLM_export_pack:      { operation: 'export',           requiresEmbedding: false },
  pluresLM_import_pack:      { operation: 'import',           requiresEmbedding: false },
  pluresLM_list_packs:       { operation: 'export',           requiresEmbedding: false },
  pluresLM_uninstall_pack:   { operation: 'direct-delete',    requiresEmbedding: false },
  pluresLM_create_procedure: { operation: 'procedure-mgmt',   requiresEmbedding: false },
  pluresLM_run_procedure:    { operation: 'procedure-exec',   requiresEmbedding: false },
  pluresLM_list_procedures:  { operation: 'procedure-mgmt',   requiresEmbedding: false },
  pluresLM_update_procedure: { operation: 'procedure-mgmt',   requiresEmbedding: false },
  pluresLM_delete_procedure: { operation: 'procedure-mgmt',   requiresEmbedding: false },
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const routeRule = defineRule<PluresLmContext>({
  id: 'operation-routing.route',
  description: 'Determine backend operation and embedding requirements for the requested tool',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'operation-routing.route',
    behavior: 'Emits operation.route fact with operation kind and embedding flag, or operation.unroutable for unknown tools',
    examples: [
      { given: 'pluresLM_store', when: 'TOOL_REQUEST', then: 'Emits operation.route { operation: embed-and-store, requiresEmbedding: true }' },
      { given: 'pluresLM_health', when: 'TOOL_REQUEST', then: 'Emits operation.route { operation: stats, requiresEmbedding: false }' },
      { given: 'unknown_tool', when: 'TOOL_REQUEST', then: 'Emits operation.unroutable' },
    ],
    invariants: [
      'Every recognized tool has exactly one route entry',
      'requiresEmbedding is true only for tools that need vector operations',
    ],
  }),
  impl: (state) => {
    const toolName = state.context.request.toolName;
    const entry = ROUTE_TABLE[toolName];

    if (!entry) {
      return RuleResult.emit([fact('operation.unroutable', { toolName })]);
    }

    return RuleResult.emit([
      fact('operation.route', {
        toolName,
        operation: entry.operation,
        requiresEmbedding: entry.requiresEmbedding,
      }),
    ]);
  },
});

const forgetRoutingRule = defineRule<PluresLmContext>({
  id: 'operation-routing.forget-mode',
  description: 'Determine whether pluresLM_forget should delete by ID or by semantic query',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'operation-routing.forget-mode',
    behavior: 'Emits operation.forget-mode with mode=id or mode=query depending on provided arguments',
    examples: [
      { given: 'pluresLM_forget with id="abc"', when: 'TOOL_REQUEST', then: 'Emits mode=id' },
      { given: 'pluresLM_forget with query="old data"', when: 'TOOL_REQUEST', then: 'Emits mode=query' },
    ],
    invariants: ['Only fires for pluresLM_forget — skips for all other tools'],
  }),
  impl: (state) => {
    const { toolName, args } = state.context.request;
    if (toolName !== 'pluresLM_forget') {
      return RuleResult.skip('Not a forget operation');
    }

    const hasId = args.id !== undefined && args.id !== null && String(args.id).trim() !== '';

    if (hasId) {
      return RuleResult.emit([fact('operation.forget-mode', { mode: 'id' })]);
    }

    return RuleResult.emit([fact('operation.forget-mode', { mode: 'query' })]);
  },
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export const operationRoutingModule = defineModule<PluresLmContext>({
  rules: [routeRule, forgetRoutingRule],
  constraints: [],
  meta: { name: 'operation-routing', version: '1.0.0' },
});

export { ROUTE_TABLE };
