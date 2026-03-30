/**
 * session-management module
 *
 * Praxis rules for MCP session lifecycle management: state
 * transitions, idle-timeout detection, rate limiting, and
 * cleanup triggers.
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
// Constants
// ---------------------------------------------------------------------------

/** Default idle-timeout threshold in milliseconds (5 minutes). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Rate-limit window in milliseconds (1 minute). */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const sessionActivationRule = defineRule<PluresLmContext>({
  id: 'session-management.activation',
  description: 'Transition session to active on any tool request',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'session-management.activation',
    behavior: 'Emits session.active fact when session is connected or idle, retracts session.idle',
    examples: [
      { given: 'Session state = connected', when: 'TOOL_REQUEST', then: 'Emits session.active' },
      { given: 'Session state = idle', when: 'TOOL_REQUEST', then: 'Retracts session.idle, emits session.active' },
      { given: 'Session state = active', when: 'TOOL_REQUEST', then: 'Noop — already active' },
    ],
    invariants: ['Expired sessions cannot be reactivated'],
  }),
  impl: (state) => {
    const sessionState = state.context.session.state;

    if (sessionState === 'expired') {
      return RuleResult.emit([fact('session.expired', { reason: 'Session has expired and cannot be reactivated' })]);
    }

    if (sessionState === 'active') {
      return RuleResult.noop('Session already active');
    }

    // connected → active  or  idle → active
    if (sessionState === 'idle') {
      return RuleResult.emit([fact('session.active', { previousState: 'idle', timestamp: Date.now() })]);
    }

    return RuleResult.emit([fact('session.active', { previousState: 'connected', timestamp: Date.now() })]);
  },
});

const idleDetectionRule = defineRule<PluresLmContext>({
  id: 'session-management.idle-detection',
  description: 'Detect sessions that have been idle beyond the timeout threshold',
  eventTypes: 'SESSION_CHECK',
  contract: defineContract({
    ruleId: 'session-management.idle-detection',
    behavior: 'Emits session.idle when last activity exceeds idle timeout',
    examples: [
      { given: 'Last active 6 minutes ago', when: 'SESSION_CHECK', then: 'Emits session.idle' },
      { given: 'Last active 2 minutes ago', when: 'SESSION_CHECK', then: 'Noop — still within threshold' },
    ],
    invariants: ['Uses IDLE_TIMEOUT_MS (5 min) as threshold'],
  }),
  impl: (state) => {
    const { lastActiveAt, state: sessionState } = state.context.session;

    if (sessionState === 'expired') {
      return RuleResult.skip('Session already expired');
    }

    const elapsed = Date.now() - lastActiveAt;
    if (elapsed > IDLE_TIMEOUT_MS) {
      return RuleResult.emit([fact('session.idle', { elapsed, threshold: IDLE_TIMEOUT_MS })]);
    }

    return RuleResult.noop('Session is within idle threshold');
  },
});

const rateLimitRule = defineRule<PluresLmContext>({
  id: 'session-management.rate-limit',
  description: 'Check whether the session has exceeded its per-minute request cap',
  eventTypes: 'TOOL_REQUEST',
  contract: defineContract({
    ruleId: 'session-management.rate-limit',
    behavior: 'Emits session.rate-limited when requests in window exceed max, or session.rate-ok otherwise',
    examples: [
      { given: '60 requests in last minute, max=60', when: 'TOOL_REQUEST', then: 'Emits session.rate-ok' },
      { given: '61 requests in last minute, max=60', when: 'TOOL_REQUEST', then: 'Emits session.rate-limited' },
    ],
    invariants: ['Rate limits reset each window', 'Default max is 60 requests per minute'],
  }),
  impl: (state) => {
    const { requestsInWindow, maxRequestsPerMinute, windowStart } = state.context.rateLimit;

    // Check if we're still in the current window
    const elapsed = Date.now() - windowStart;
    if (elapsed > RATE_LIMIT_WINDOW_MS) {
      // Window has reset — new window, always ok
      return RuleResult.emit([fact('session.rate-ok', { requestsInWindow: 1, windowReset: true })]);
    }

    if (requestsInWindow > maxRequestsPerMinute) {
      return RuleResult.emit([
        fact('session.rate-limited', {
          requestsInWindow,
          maxRequestsPerMinute,
          retryAfterMs: RATE_LIMIT_WINDOW_MS - elapsed,
        }),
      ]);
    }

    return RuleResult.emit([fact('session.rate-ok', { requestsInWindow })]);
  },
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const sessionNotExpiredConstraint = defineConstraint<PluresLmContext>({
  id: 'session-management.not-expired',
  description: 'Reject requests on expired sessions',
  contract: defineContract({
    ruleId: 'session-management.not-expired',
    behavior: 'Passes when session state is not expired; fails otherwise',
    examples: [
      { given: 'session.state = active', when: 'Constraint evaluated', then: 'Passes' },
      { given: 'session.state = expired', when: 'Constraint evaluated', then: 'Fails' },
    ],
    invariants: ['An expired session can never pass this constraint'],
  }),
  impl: (state) => {
    if (state.context.session.state === 'expired') {
      return 'Session has expired — please reconnect';
    }
    return true;
  },
});

const rateLimitConstraint = defineConstraint<PluresLmContext>({
  id: 'session-management.within-rate-limit',
  description: 'Enforce rate limit as a hard constraint',
  contract: defineContract({
    ruleId: 'session-management.within-rate-limit',
    behavior: 'Passes when requests in window are below max; fails when exceeded',
    examples: [
      { given: '60 requests, max=60', when: 'Constraint evaluated', then: 'Passes (at limit, not over)' },
      { given: '61 requests, max=60', when: 'Constraint evaluated', then: 'Fails' },
    ],
    invariants: ['Uses the same window as the rate-limit rule'],
  }),
  impl: (state) => {
    const { requestsInWindow, maxRequestsPerMinute, windowStart } = state.context.rateLimit;

    const elapsed = Date.now() - windowStart;
    if (elapsed > RATE_LIMIT_WINDOW_MS) return true; // Window reset

    if (requestsInWindow > maxRequestsPerMinute) {
      return `Rate limit exceeded: ${requestsInWindow}/${maxRequestsPerMinute} requests per minute`;
    }

    return true;
  },
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export const sessionManagementModule = defineModule<PluresLmContext>({
  rules: [sessionActivationRule, idleDetectionRule, rateLimitRule],
  constraints: [sessionNotExpiredConstraint, rateLimitConstraint],
  meta: { name: 'session-management', version: '1.0.0' },
});

export { IDLE_TIMEOUT_MS, RATE_LIMIT_WINDOW_MS };
