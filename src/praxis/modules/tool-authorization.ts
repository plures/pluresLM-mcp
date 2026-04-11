/**
 * tool-authorization module
 *
 * Praxis rules that govern which MCP tools are available and
 * gate access based on transport mode and API-key presence.
 */

import {
  defineModule,
  defineRule,
  defineConstraint,
  defineContract,
  RuleResult,
  fact,
} from '@plures/praxis/core';

import type { PluresLmContext, ToolCategory } from '../context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map every known tool name to its logical category. */
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  pluresLM_store:            'core-memory',
  pluresLM_search:           'search',
  pluresLM_forget:           'core-memory',
  pluresLM_get:              'core-memory',
  pluresLM_update:           'core-memory',
  pluresLM_list:             'core-memory',
  pluresLM_search_text:      'search',
  pluresLM_query:            'search',
  pluresLM_query_dsl:        'search',
  pluresLM_index:            'indexing',
  pluresLM_profile:          'status',
  pluresLM_status:           'status',
  pluresLM_sync_status:      'status',
  pluresLM_health:           'status',
  pluresLM_world_state:      'status',
  pluresLM_daily_summary:    'status',
  pluresLM_consolidate:      'maintenance',
  pluresLM_find_stale:       'maintenance',
  pluresLM_export_bundle:    'export-import',
  pluresLM_restore_bundle:   'export-import',
  pluresLM_export_pack:      'export-import',
  pluresLM_import_pack:      'export-import',
  pluresLM_list_packs:       'export-import',
  pluresLM_uninstall_pack:   'export-import',
  pluresLM_create_procedure: 'procedures',
  pluresLM_run_procedure:    'procedures',
  pluresLM_list_procedures:  'procedures',
  pluresLM_update_procedure: 'procedures',
  pluresLM_delete_procedure: 'procedures',
  pluresLM_autolink:         'maintenance',
  pluresLM_graph_neighbors:  'search',
  pluresLM_graph_insights:   'status',
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const toolCategoryRule = defineRule<PluresLmContext>({
  id: 'tool-authorization.classify',
  description: 'Classify the requested tool into its authorization category',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'tool-authorization.classify',
    behavior: 'Emits a tool.category fact when the tool is recognized, or a tool.unknown fact otherwise',
    examples: [
      { given: 'A request for pluresLM_store', when: 'TOOL_REQUEST event', then: 'Emits tool.category = core-memory' },
      { given: 'A request for unknown_tool', when: 'TOOL_REQUEST event', then: 'Emits tool.unknown fact' },
    ],
    invariants: ['Every recognized tool maps to exactly one category'],
  }),
  impl: (state: any) => {
    const toolName = state.context.request.toolName;
    const category = TOOL_CATEGORIES[toolName];
    if (category) {
      return RuleResult.emit([fact('tool.category', { toolName, category })]);
    }
    return RuleResult.emit([fact('tool.unknown', { toolName })]);
  },
});

const httpAuthGateRule = defineRule<PluresLmContext>({
  id: 'tool-authorization.http-auth-gate',
  description: 'Gate destructive operations behind API-key authentication on HTTP transports',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'tool-authorization.http-auth-gate',
    behavior: 'Skips for stdio transport; emits tool.auth-required when HTTP transport lacks an API key for write operations',
    examples: [
      { given: 'stdio transport', when: 'TOOL_REQUEST', then: 'Skips — stdio is trusted' },
      { given: 'HTTP transport with API key', when: 'TOOL_REQUEST for pluresLM_store', then: 'Noop — auth present' },
      { given: 'HTTP transport without API key', when: 'TOOL_REQUEST for pluresLM_store', then: 'Emits tool.auth-required' },
    ],
    invariants: ['stdio transport always passes', 'Read-only status tools never require auth'],
  }),
  impl: (state: any) => {
    if (state.context.config.transport === 'stdio') {
      return RuleResult.skip('stdio transport — trusted local pipe');
    }

    const toolName = state.context.request.toolName;
    const category = TOOL_CATEGORIES[toolName];

    // Read-only categories never need auth gating
    if (category === 'status' || category === 'search') {
      return RuleResult.noop('Read-only tool — no auth gate needed');
    }

    if (!state.context.config.hasApiKey) {
      return RuleResult.emit([fact('tool.auth-required', { toolName, category })]);
    }

    return RuleResult.noop('API key is configured');
  },
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const knownToolConstraint = defineConstraint<PluresLmContext>({
  id: 'tool-authorization.known-tool',
  description: 'The requested tool must be a recognized PluresLM tool',
  contract: defineContract({
    ruleId: 'tool-authorization.known-tool',
    behavior: 'Returns true when the tool name exists in the tool catalog, error message otherwise',
    examples: [
      { given: 'toolName = pluresLM_store', when: 'Constraint evaluated', then: 'Passes (true)' },
      { given: 'toolName = bogus_tool', when: 'Constraint evaluated', then: 'Fails with message' },
    ],
    invariants: ['Constraint is stateless — depends only on tool name'],
  }),
  impl: (state: any) => {
    const toolName = state.context.request.toolName;
    if (toolName in TOOL_CATEGORIES) return true;
    return `Unknown tool: ${toolName}`;
  },
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export const toolAuthorizationModule = defineModule<PluresLmContext>({
  rules: [toolCategoryRule, httpAuthGateRule],
  constraints: [knownToolConstraint],
  meta: { name: 'tool-authorization', version: '1.0.0' },
});

export { TOOL_CATEGORIES };
