/**
 * dsh-codex M2 — codex compaction policy (pure logic).
 *
 * Port of codex HEAD 5bc8da6d78 behavior (core/src/compact.rs):
 * - Trigger: active tokens ≥ auto_compact_token_limit (context window × 9/10)
 *   plus a fallback buffer, or ≥ the full window.
 * - Retained history: user messages only, newest-first, total ≤
 *   COMPACT_USER_MESSAGE_MAX_TOKENS (20,000); the oldest retained message is
 *   truncated to the remaining budget. Everything else is dropped.
 * - The summary is appended as the final user message with SUMMARY_PREFIX,
 *   or `(no summary available)` when empty.
 * - Token estimates use the codex bytes/4 heuristic (history.rs:247-271);
 *   callers may supply a tokenizer-accurate estimator.
 *
 * @module dsh-codex/harness/compact
 */

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20000
export const AUTO_COMPACT_FRACTION = 0.9
export const APPROX_BYTES_PER_TOKEN = 4
export const TRUNCATION_NOTICE = '\n[... text truncated by compaction ...]'

/** codex prompts/templates/compact/prompt.md (verbatim port). */
export const SUMMARIZATION_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  '',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  '',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.',
].join('\n')

/** codex prompts/templates/compact/summary_prefix.md (verbatim port). */
export const SUMMARY_PREFIX = [
  'Another language model started to solve this problem and produced a summary of its thinking process.',
  'You also have access to the state of the tools that were used by that language model.',
  'Use this to build on the work that has already been done and avoid duplicating work.',
  'Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:',
].join(' ')

export const NO_SUMMARY_TEXT = '(no summary available)'

/** codex compact.rs:389-392 user-facing warning after compaction. */
export const COMPACTION_WARNING =
  'Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.'

/** codex bytes/4 heuristic (truncate.rs:71-74, history.rs:246). */
export function approxTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') / APPROX_BYTES_PER_TOKEN)
}

/** Approximate byte budget for a token count (truncate.rs). */
export function approxBytesForTokens(tokens) {
  return tokens * APPROX_BYTES_PER_TOKEN
}

/**
 * Middle truncation port (utils/string/src/truncate.rs truncate_with_byte_estimate,
 * use_tokens=true): keep head and tail around the marker, splitting the budget
 * 50/50 on byte boundaries.
 */
export function truncateMiddle(text, maxBytes) {
  if (text === '') return ''
  if (maxBytes <= 0) {
    const removed = Buffer.byteLength(text, 'utf8')
    return marker(Math.ceil(removed / APPROX_BYTES_PER_TOKEN))
  }
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= maxBytes) return text
  const leftBudget = Math.floor(maxBytes / 2)
  const rightBudget = maxBytes - leftBudget
  const tailStartTarget = totalBytes - rightBudget
  let prefixEnd = 0
  let suffixStart = totalBytes
  let suffixStarted = false
  let bytePos = 0
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, 'utf8')
    const charEnd = bytePos + charBytes
    if (charEnd <= leftBudget) { prefixEnd = charEnd; bytePos = charEnd; continue }
    if (bytePos >= tailStartTarget) {
      if (!suffixStarted) { suffixStart = bytePos; suffixStarted = true }
      bytePos = charEnd
      continue
    }
    bytePos = charEnd
  }
  if (suffixStart < prefixEnd) suffixStart = prefixEnd
  const before = text.slice(0, prefixEnd)
  const after = text.slice(suffixStart)
  const removedBytes = totalBytes - (Buffer.byteLength(before, 'utf8') + Buffer.byteLength(after, 'utf8'))
  return before + marker(Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN)) + after
}

/** The official "…N tokens truncated…" marker (truncate.rs:131-137). */
function marker(removedTokens) {
  return '…' + removedTokens + ' tokens truncated…'
}

/** Truncate text to a token budget with the official middle-truncation marker. */
export function truncateTokens(text, maxTokens) {
  if (approxTokens(text) <= maxTokens) return { text, truncated: false }
  return { text: truncateMiddle(text, approxBytesForTokens(maxTokens)), truncated: true }
}
/**
 * codex context_window.rs:74-79 trigger condition.
 * @returns true when compaction must run.
 */
export function shouldCompact({ activeTokens, contextWindow, fallbackBuffer = 0 }) {
  const limit = Math.floor(contextWindow * AUTO_COMPACT_FRACTION)
  return activeTokens >= limit + fallbackBuffer || activeTokens >= contextWindow
}

/**
 * Select retained user messages, newest-first, within the token budget.
 * The oldest retained message is truncated to fit; older messages drop.
 * @param userMessages - user-role message texts in chronological order.
 * @param opts.maxTokens - budget (default COMPACT_USER_MESSAGE_MAX_TOKENS).
 * @param opts.estimate - token estimator (default bytes/4).
 * @returns {retained, dropped} where retained is chronological and each entry
 *   is {text, truncated}.
 */
export function selectUserMessages(userMessages, { maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS, estimate = approxTokens } = {}) {
  const selected = []
  let remaining = maxTokens
  for (let i = userMessages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = userMessages[i]
    const tokens = estimate(message)
    if (tokens <= remaining) {
      selected.push({ text: message, truncated: false })
      remaining -= tokens
    } else {
      const truncated = truncateTokens(message, remaining)
      selected.push({ text: truncated.text, truncated: true })
      break
    }
  }
  selected.reverse()
  return { retained: selected, dropped: userMessages.length - selected.length }
}

/**
 * Rebuild the history after compaction (compact.rs:639-717): initial
 * context, then the retained user messages, then the summary message.
 * Assistant/tool messages are dropped — the summary carries their state.
 * @returns new message list [{role, text, truncated?}].
 */
export function buildCompactedHistory({ initialContext = [], userMessages, summaryText, maxTokens, estimate }) {
  const { retained } = selectUserMessages(userMessages, { maxTokens, estimate })
  const history = [...initialContext]
  for (const message of retained) history.push({ role: 'user', text: message.text, ...(message.truncated ? { truncated: true } : {}) })
  history.push(summaryMessage(summaryText))
  return history
}

/** The summary message shape appended by build_compacted_history. */
export function summaryMessage(summaryText) {
  const text = summaryText === undefined || summaryText.trim().length === 0 ? NO_SUMMARY_TEXT : `${SUMMARY_PREFIX}\n${summaryText}`
  return { role: 'user', text }
}
