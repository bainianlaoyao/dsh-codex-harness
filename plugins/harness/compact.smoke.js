/**
 * Smoke test for dsh-codex/harness/compact.js — trigger threshold, retained
 * user-message selection with oldest-truncation, summary assembly, and the
 * verbatim prompt templates.
 *
 * Usage: node dsh-codex/harness/compact.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
  NO_SUMMARY_TEXT,
  shouldCompact,
  selectUserMessages,
  buildCompactedHistory,
  summaryMessage,
  truncateTokens,
} = await import('./compact.js')

// ── trigger ────────────────────────────────────────────────────────────────
assert.equal(shouldCompact({ activeTokens: 899, contextWindow: 1000 }), false)
assert.equal(shouldCompact({ activeTokens: 900, contextWindow: 1000 }), true) // 90%
assert.equal(shouldCompact({ activeTokens: 1000, contextWindow: 1000 }), true)
assert.equal(shouldCompact({ activeTokens: 909, contextWindow: 1000, fallbackBuffer: 10 }), false)
assert.equal(shouldCompact({ activeTokens: 910, contextWindow: 1000, fallbackBuffer: 10 }), true)

// ── retention ──────────────────────────────────────────────────────────────
const messages = ['m1', 'm2', 'm3', 'm4']
const { retained, dropped } = selectUserMessages(messages, { maxTokens: 4, estimate: (text) => text.length })
assert.equal(dropped, 2, 'oldest dropped over budget')
assert.deepEqual(retained.map((m) => m.text), ['m3', 'm4'])
assert.equal(retained[0].truncated, false)

const big = 'x'.repeat(1000)
const r2 = selectUserMessages([big, 'last'], { maxTokens: 10, estimate: (text) => text.length })
assert.equal(r2.retained.length, 2, 'oldest truncated to remaining budget, newest kept')
assert.equal(r2.retained[0].truncated, true)
assert.ok(r2.retained[0].text.length < 1000)

// ── history rebuild ────────────────────────────────────────────────────────
const history = buildCompactedHistory({
  initialContext: [{ role: 'user', text: '<environment_context>' }],
  userMessages: ['older-user', 'newer-user'],
  summaryText: 'progress summary',
  estimate: (text) => text.length,
  maxTokens: 100,
})
assert.deepEqual(history.map((m) => m.role), ['user', 'user', 'user', 'user'])
assert.equal(history[1].text, 'older-user')
assert.equal(history[2].text, 'newer-user')
assert.ok(history[3].text.includes(SUMMARY_PREFIX.slice(0, 40)), 'summary message carries prefix')
assert.ok(history[3].text.endsWith('progress summary'))

// ── summary assembly ───────────────────────────────────────────────────────
assert.equal(summaryMessage('').text, NO_SUMMARY_TEXT)
assert.equal(summaryMessage(undefined).text, NO_SUMMARY_TEXT)
assert.ok(summaryMessage('x').text.startsWith(SUMMARY_PREFIX))

// ── truncation ─────────────────────────────────────────────────────────────
assert.deepEqual(truncateTokens('short', 100), { text: 'short', truncated: false })
assert.equal(truncateTokens('abcdefgh', 1).truncated, true)

// ── templates present ──────────────────────────────────────────────────────
assert.ok(SUMMARIZATION_PROMPT.includes('CONTEXT CHECKPOINT COMPACTION'))
assert.ok(SUMMARY_PREFIX.includes('Another language model started to solve this problem'))
assert.equal(COMPACT_USER_MESSAGE_MAX_TOKENS, 20000)

console.log('compact smoke test: ALL PASS')
