/**
 * Smoke test for dsh-codex/harness/approvals.js — decision vocabulary,
 * context-dependent available_decisions, the session approval cache, and the
 * sandbox-denial escalation matrix (untrusted re-prompts; on-request/never
 * do not; deny-read blocks unsandboxed retries).
 *
 * Usage: node dsh-codex/harness/approvals.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const { REVIEW_DECISION, RETRY_REASON, availableDecisions, ApprovalCache, networkApprovalKey, escalationDecision, allowsExplicitEscalation } = await import('./approvals.js')

// ── available_decisions ────────────────────────────────────────────────────
const normal = availableDecisions({})
assert.deepEqual(normal, [REVIEW_DECISION.approved, REVIEW_DECISION.approvedExecpolicyAmendment, REVIEW_DECISION.abort])
const escalated = availableDecisions({ additionalPermissions: true })
assert.deepEqual(escalated, [REVIEW_DECISION.approved, REVIEW_DECISION.abort])
const network = availableDecisions({ network: true })
assert.deepEqual(network, [REVIEW_DECISION.approved, REVIEW_DECISION.approvedForSession, REVIEW_DECISION.networkPolicyAmendment, REVIEW_DECISION.abort])

// ── session approval cache ─────────────────────────────────────────────────
const cache = new ApprovalCache()
assert.equal(cache.isApproved(['git', 'status']), false)
cache.approve(['git', 'status'])
assert.equal(cache.isApproved(['git', 'status']), true)
assert.equal(cache.isApproved(['git', 'log']), false)
assert.equal(cache.size, 1)

// The cache is deliberately dumb about wrappers: the harness canonicalizes
// before consulting it, so distinct raw forms key separately.
const cache2 = new ApprovalCache()
cache2.approve(['bash', '-lc', 'git status'])
assert.equal(cache2.isApproved(['git', 'status']), false, 'raw keys differ per form (canonicalize first)')
assert.equal(cache2.isApproved(['bash', '-lc', 'git status']), true)
cache2.clear()
assert.equal(cache2.size, 0)

// ── network key ────────────────────────────────────────────────────────────
assert.equal(networkApprovalKey({ host: 'example.com' }), '|example.com|https|')
assert.notEqual(networkApprovalKey({ host: 'example.com', port: 443 }), networkApprovalKey({ host: 'example.com' }))

// ── escalation matrix (orchestrator.rs:299-497) ────────────────────────────
assert.equal(escalationDecision({ policy: 'untrusted' }).retry, 'approve-unsandboxed')
assert.equal(escalationDecision({ policy: 'untrusted' }).reason, RETRY_REASON)
assert.equal(escalationDecision({ policy: 'granular', granularSandboxApproval: true }).retry, 'approve-unsandboxed')
assert.equal(escalationDecision({ policy: 'granular', granularSandboxApproval: false }).retry, 'none')
assert.equal(escalationDecision({ policy: 'on-request' }).retry, 'none')
assert.equal(escalationDecision({ policy: 'never' }).retry, 'none')
assert.equal(escalationDecision({ policy: 'untrusted', hasDenyRead: true }).retry, 'none')
assert.equal(escalationDecision({ policy: 'untrusted', hasDenyRead: true }).reason, 'deny-read configured; unsandboxed retry forbidden')

// ── explicit escalation ────────────────────────────────────────────────────
assert.equal(allowsExplicitEscalation('on-request'), true)
assert.equal(allowsExplicitEscalation('untrusted'), false)
assert.equal(allowsExplicitEscalation('never'), false)

console.log('approvals smoke test: ALL PASS')
