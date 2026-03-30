/**
 * request-validation module
 *
 * Praxis rules that validate incoming MCP tool parameters before
 * the handler executes.  Centralises the scattered `if (!x) throw`
 * checks from the tool handler into declarative rules.
 */

import {
  defineModule,
  defineRule,
  defineConstraint,
  defineContract,
  RuleResult,
  fact,
} from '@plures/praxis/core';

import type { PluresLmContext } from '../context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tools that require a non-empty string argument named `content`. */
const CONTENT_REQUIRED = new Set(['pluresLM_store']);

/** Tools that require a non-empty string argument named `query`. */
const QUERY_REQUIRED = new Set([
  'pluresLM_search',
  'pluresLM_search_text',
  'pluresLM_query',
  'pluresLM_query_dsl',
]);

/** Tools that require a non-empty string argument named `id`. */
const ID_REQUIRED = new Set(['pluresLM_get', 'pluresLM_update']);

/** Tools that require a non-empty string argument named `name`. */
const NAME_REQUIRED = new Set([
  'pluresLM_export_pack',
  'pluresLM_uninstall_pack',
  'pluresLM_create_procedure',
  'pluresLM_run_procedure',
  'pluresLM_update_procedure',
  'pluresLM_delete_procedure',
]);

/** Tools that require a non-empty string argument named `directory`. */
const DIRECTORY_REQUIRED = new Set(['pluresLM_index']);

/** Tools that require a non-empty string argument named `date`. */
const DATE_REQUIRED = new Set(['pluresLM_daily_summary']);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const requiredFieldsRule = defineRule<PluresLmContext>({
  id: 'request-validation.required-fields',
  description: 'Validate that required string fields are present and non-empty',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'request-validation.required-fields',
    behavior: 'Emits request.valid when all required fields are present, or request.invalid with missing fields',
    examples: [
      { given: 'pluresLM_store with content="hello"', when: 'TOOL_REQUEST', then: 'Emits request.valid' },
      { given: 'pluresLM_store with no content', when: 'TOOL_REQUEST', then: 'Emits request.invalid listing content' },
      { given: 'pluresLM_health (no required fields)', when: 'TOOL_REQUEST', then: 'Emits request.valid' },
    ],
    invariants: [
      'A tool not in any required-field set is always valid (no required fields)',
      'Empty-string values are treated as missing',
    ],
  }),
  impl: (state) => {
    const { toolName, args } = state.context.request;
    const missing: string[] = [];

    const checkString = (field: string) => {
      const val = args[field];
      if (val === undefined || val === null || String(val).trim() === '') {
        missing.push(field);
      }
    };

    if (CONTENT_REQUIRED.has(toolName)) checkString('content');
    if (QUERY_REQUIRED.has(toolName))   checkString('query');
    if (ID_REQUIRED.has(toolName))      checkString('id');
    if (NAME_REQUIRED.has(toolName))    checkString('name');
    if (DIRECTORY_REQUIRED.has(toolName)) checkString('directory');
    if (DATE_REQUIRED.has(toolName))    checkString('date');

    if (missing.length > 0) {
      return RuleResult.emit([fact('request.invalid', { toolName, missing })]);
    }

    return RuleResult.emit([fact('request.valid', { toolName })]);
  },
});

const numericBoundsRule = defineRule<PluresLmContext>({
  id: 'request-validation.numeric-bounds',
  description: 'Validate optional numeric parameters fall within sensible bounds',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'request-validation.numeric-bounds',
    behavior: 'Emits request.param-warning when numeric params are out of expected range',
    examples: [
      { given: 'pluresLM_search with limit=5', when: 'TOOL_REQUEST', then: 'Noop — within bounds' },
      { given: 'pluresLM_search with limit=-1', when: 'TOOL_REQUEST', then: 'Emits request.param-warning' },
    ],
    invariants: ['Never blocks a request — only advisory warnings'],
  }),
  impl: (state) => {
    const { args } = state.context.request;
    const warnings: string[] = [];

    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (Number.isNaN(n) || n < 0)  warnings.push('limit must be a non-negative number');
      if (n > 1000)                  warnings.push('limit exceeds 1000 — consider pagination');
    }

    if (args.offset !== undefined) {
      const n = Number(args.offset);
      if (Number.isNaN(n) || n < 0) warnings.push('offset must be a non-negative number');
    }

    if (args.minScore !== undefined) {
      const n = Number(args.minScore);
      if (Number.isNaN(n) || n < 0 || n > 1) warnings.push('minScore should be between 0 and 1');
    }

    if (args.similarityThreshold !== undefined) {
      const n = Number(args.similarityThreshold);
      if (Number.isNaN(n) || n < 0 || n > 1) warnings.push('similarityThreshold should be between 0 and 1');
    }

    if (warnings.length > 0) {
      return RuleResult.emit([fact('request.param-warning', { warnings })]);
    }

    return RuleResult.noop('All numeric parameters within bounds');
  },
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const forgetMutualExclusionConstraint = defineConstraint<PluresLmContext>({
  id: 'request-validation.forget-requires-id-or-query',
  description: 'pluresLM_forget must receive either id or query',
  contract: defineContract({
    ruleId: 'request-validation.forget-requires-id-or-query',
    behavior: 'Passes when id or query is provided; fails when neither is given',
    examples: [
      { given: 'pluresLM_forget with id="abc"', when: 'Constraint evaluated', then: 'Passes' },
      { given: 'pluresLM_forget with query="old stuff"', when: 'Constraint evaluated', then: 'Passes' },
      { given: 'pluresLM_forget with no id and no query', when: 'Constraint evaluated', then: 'Fails' },
    ],
    invariants: ['Only evaluated for pluresLM_forget — all other tools pass unconditionally'],
  }),
  impl: (state) => {
    const { toolName, args } = state.context.request;
    if (toolName !== 'pluresLM_forget') return true;

    const hasId = args.id !== undefined && args.id !== null && String(args.id).trim() !== '';
    const hasQuery = args.query !== undefined && args.query !== null && String(args.query).trim() !== '';

    if (hasId || hasQuery) return true;
    return 'pluresLM_forget requires either id or query';
  },
});

const bundleRequiredConstraint = defineConstraint<PluresLmContext>({
  id: 'request-validation.bundle-required',
  description: 'pluresLM_restore_bundle must receive a bundle object',
  contract: defineContract({
    ruleId: 'request-validation.bundle-required',
    behavior: 'Passes when bundle is provided; fails when missing',
    examples: [
      { given: 'pluresLM_restore_bundle with bundle={...}', when: 'Constraint evaluated', then: 'Passes' },
      { given: 'pluresLM_restore_bundle with no bundle', when: 'Constraint evaluated', then: 'Fails' },
    ],
    invariants: ['Only evaluated for pluresLM_restore_bundle'],
  }),
  impl: (state) => {
    const { toolName, args } = state.context.request;
    if (toolName !== 'pluresLM_restore_bundle') return true;
    if (args.bundle) return true;
    return 'bundle is required for pluresLM_restore_bundle';
  },
});

const packRequiredConstraint = defineConstraint<PluresLmContext>({
  id: 'request-validation.pack-required',
  description: 'pluresLM_import_pack must receive a pack object',
  contract: defineContract({
    ruleId: 'request-validation.pack-required',
    behavior: 'Passes when pack is provided; fails when missing',
    examples: [
      { given: 'pluresLM_import_pack with pack={...}', when: 'Constraint evaluated', then: 'Passes' },
      { given: 'pluresLM_import_pack with no pack', when: 'Constraint evaluated', then: 'Fails' },
    ],
    invariants: ['Only evaluated for pluresLM_import_pack'],
  }),
  impl: (state) => {
    const { toolName, args } = state.context.request;
    if (toolName !== 'pluresLM_import_pack') return true;
    if (args.pack) return true;
    return 'pack is required for pluresLM_import_pack';
  },
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export const requestValidationModule = defineModule<PluresLmContext>({
  rules: [requiredFieldsRule, numericBoundsRule],
  constraints: [forgetMutualExclusionConstraint, bundleRequiredConstraint, packRequiredConstraint],
  meta: { name: 'request-validation', version: '1.0.0' },
});
