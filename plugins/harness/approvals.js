/**
 * dsh-codex M2 — approval orchestration vocabulary and escalation policy
 * (pure logic; the UI and the harness loop consume these).
 *
 * Port of codex HEAD 5bc8da6d78:
 * - ReviewDecision vocabulary (protocol.rs:3852-3887).
 * - available_decisions computed per approval context
 *   (protocol/src/approvals.rs:314-347).
 * - Session-scoped approval cache keyed by canonicalized command
 *   (tools/sandboxing.rs:70-116).
 * - Sandbox-denial escalation orchestration (tools/orchestrator.rs:299-497):
 *   under `untrusted` (or granular with sandbox_approval) a denied command
 *   re-prompts with the fixed retry reason and may run unsandboxed; under
 *   `never` / `on-request` the denial is returned to the model with no retry.
 *   Deny-read configured ⇒ unsandboxed retry is forbidden (sandboxing.rs:275-279).
 *
 * @module dsh-codex/harness/approvals
 */

/** Stable retry reason shown when a sandboxed run was denied (orchestrator.rs:527-531). */
export const RETRY_REASON = 'command failed; retry without sandbox?'

/** ReviewDecision vocabulary (protocol.rs:3852-3887). */
export const REVIEW_DECISION = Object.freeze({
  approved: 'approved',
  approvedExecpolicyAmendment: 'approved-execpolicy-amendment',
  approvedForSession: 'approved-for-session',
  approvedMcpPolicyAmendment: 'approved-mcp-policy-amendment',
  networkPolicyAmendment: 'network-policy-amendment',
  denied: 'denied',
  timedOut: 'timed-out',
  abort: 'abort',
})

/**
 * The decision set a UI may offer for one approval request
 * (approvals.rs:314-347): normal commands add the execpolicy amendment;
 * escalation requests drop it; network requests offer session-wide approval
 * and a persistent network-policy amendment.
 */
export function availableDecisions({ network = false, additionalPermissions = false } = {}) {
  const decisions = [REVIEW_DECISION.approved]
  if (network) {
    decisions.push(REVIEW_DECISION.approvedForSession, REVIEW_DECISION.networkPolicyAmendment)
  } else if (!additionalPermissions) {
    decisions.push(REVIEW_DECISION.approvedExecpolicyAmendment)
  }
  decisions.push(REVIEW_DECISION.abort)
  return decisions
}

/** Session-scoped approval cache keyed by canonicalized command arrays. */
export class ApprovalCache {
  constructor() {
    this.keys = new Set()
  }
  static key(command) {
    return JSON.stringify(command)
  }
  approve(command) {
    this.keys.add(ApprovalCache.key(command))
  }
  isApproved(command) {
    return this.keys.has(ApprovalCache.key(command))
  }
  clear() {
    this.keys.clear()
  }
  get size() {
    return this.keys.size
  }
}

/** Network approval cache key: (environmentId, host, protocol, port). */
export function networkApprovalKey({ environmentId = '', host, protocol = 'https', port }) {
  return `${environmentId}|${host}|${protocol}|${port ?? ''}`
}

/**
 * Decide what happens after a sandboxed run was denied.
 * @param opts.policy - approval policy ('untrusted' | 'on-request' | 'granular' | 'never').
 * @param opts.granularSandboxApproval - granular policy's sandbox_approval switch.
 * @param opts.hasDenyRead - deny-read paths are configured (blocks unsandboxed retry).
 * @returns {retry: 'approve-unsandboxed' | 'none', reason?: string}
 */
export function escalationDecision({ policy, granularSandboxApproval = true, hasDenyRead = false }) {
  const mayReprompt = policy === 'untrusted' || (policy === 'granular' && granularSandboxApproval)
  if (!mayReprompt) return { retry: 'none' }
  if (hasDenyRead) return { retry: 'none', reason: 'deny-read configured; unsandboxed retry forbidden' }
  return { retry: 'approve-unsandboxed', reason: RETRY_REASON }
}

/** True when the policy allows the model-visible `require_escalated` path. */
export function allowsExplicitEscalation(policy) {
  return policy === 'on-request'
}
