/**
 * dsh-codex — canonical context comparator (part 3).
 *
 * Diffs the two canonical conversations produced by replaying the same
 * mock trajectory on the official codex CLI and on the DSH harness.
 * Normalization applied before diffing:
 *   - CRLF -> LF (pwsh writes CRLF, git bash writes LF)
 *   - wall time values (N decimals) -> <wall>
 *   - chunk ids (6 hex) -> <chunk>
 *   - session ids (>=1000) -> <sid>
 *   - ISO timestamps in injected context -> <ts>
 * Lines are classified: user / assistant / tool-call / tool-result.
 * DSH-injected user messages (runtime-context snapshot, skills
 * system-reminder) are counted separately as harness-injected and are
 * excluded from the strict sequence diff.
 *
 * Usage: node compare-contexts.mjs <codex-context.jsonl> <dsh-context.jsonl>
 *
 * @module dsh-codex/alignment/replay/compare-contexts
 */

import { readFileSync } from 'node:fs'

/** DSH-injected user-message prefixes (no codex counterpart). */
const DSH_INJECTED_PREFIXES = [
  "Current runtime context.",
  "<system-reminder>",
];

/** Normalize one canonical line. */
export function normalizeLine(line) {
  const out = { ...line }
  // isError is DSH presentation metadata; errors surface in the output text.
  if (out.role === 'tool-result') delete out.isError
  if (typeof out.text === "string") {
    out.text = out.text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/Wall time: [\d.]+ seconds/g, "Wall time: <wall> seconds")
      .replace(/Chunk ID: [0-9a-f]{6}/g, "Chunk ID: <chunk>")
      .replace(/Process running with session ID \d+/g, "Process running with session ID <sid>")
      .replace(/Original token count: \d+/g, "Original token count: <tokens>")
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g, "<ts>")
      .replace(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g, "<current_date><ts></current_date>")
  }
  if (typeof out.output === "string") {
    out.output = out.output
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/Wall time: [\d.]+ seconds/g, "Wall time: <wall> seconds")
      .replace(/Chunk ID: [0-9a-f]{6}/g, "Chunk ID: <chunk>")
      .replace(/Process running with session ID \d+/g, "Process running with session ID <sid>")
      .replace(/session ID \d+/g, "session ID <sid>")
      .replace(/Original token count: \d+/g, "Original token count: <tokens>")
  }
  if (typeof out.arguments === "string") {
    out.arguments = out.arguments
      .replace(/session_id":\s*\d+/g, 'session_id": <sid>')
    // apply_patch is freeform on the wire; the DSH internal transport wraps
    // the raw patch in {"patch": ...} — unwrap for comparison.
    try {
      const parsed = JSON.parse(out.arguments)
      if (parsed && typeof parsed.patch === "string" && typeof parsed === "object" && Object.keys(parsed).length === 1) {
        out.arguments = parsed.patch
      }
    } catch {}
  }
  if (typeof out.output === "string") {
    // DSH surfaces thrown tool errors as "Error: {message}".
    out.output = out.output.replace(/^Error: /, "")
  }
  return out
}

/** Harness-metadata lines without a codex counterpart (turn boundaries). */
function isMetadata(line) {
  return line.role === 'turn-end'
}

/** Whether a user line is a harness-injected message on the given side. */
export function isInjected(side, line) {
  if (line.role !== "user" || typeof line.text !== "string") return false
  return DSH_INJECTED_PREFIXES.some((p) => line.text.startsWith(p))
}

/**
 * Diff two canonical contexts (LCS-based sequence alignment over the
 * normalized lines, excluding DSH-injected user messages).
 * @returns {matched, diffs, injectedDsh, stats}
 */
export function compareContexts(codexLines, dshLines) {
  const codexClean = codexLines.filter((l) => !isInjected("codex", l) && !isMetadata(l))
  const dshAll = dshLines
  const dshClean = dshAll.filter((l) => !isInjected("dsh", l) && !isMetadata(l))
  const injectedDsh = dshAll.length - dshClean.length
  // Canonical key: sorted property order (codex and DSH emit the same fields
  // in different orders).
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
    }
    return value
  }
  const key = (l) => JSON.stringify(canonical(normalizeLine(l)))
  // LCS over indices
  const n = codexClean.length, m = dshClean.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(codexClean[i]) === key(dshClean[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const diffs = []
  let matched = 0
  let i = 0, j = 0
  while (i < n && j < m) {
    if (key(codexClean[i]) === key(dshClean[j])) { matched++; i++; j++; continue }
    if (dp[i + 1][j] >= dp[i][j + 1]) { diffs.push({ side: "codex-only", line: codexClean[i] }); i++ }
    else { diffs.push({ side: "dsh-only", line: dshClean[j] }); j++ }
  }
  while (i < n) { diffs.push({ side: "codex-only", line: codexClean[i] }); i++ }
  while (j < m) { diffs.push({ side: "dsh-only", line: dshClean[j] }); j++ }
  const stats = {
    codexTotal: n,
    dshTotal: m,
    matched,
    diffs: diffs.length,
    injectedDsh,
    diffRoles: diffs.reduce((acc, d) => {
      const role = d.line.role ?? "unknown"
      acc[role] = (acc[role] ?? 0) + 1
      return acc
    }, {}),
  }
  return { matched, diffs, injectedDsh, stats }
}

function loadLines(p) {
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

const isMain = process.argv[1] && (process.argv[1].endsWith("compare-contexts.mjs"))
if (isMain) {
  const [codexPath, dshPath] = process.argv.slice(2)
  const result = compareContexts(loadLines(codexPath), loadLines(dshPath))
  console.log(JSON.stringify(result.stats, null, 2))
  for (const d of result.diffs) {
    console.log(`  [${d.side}] ${d.line.role}: ${JSON.stringify(d.line).slice(0, 400)}`)
  }
}