/**
 * dsh-codex M1 — `exec_command` + `write_stdin` over the DSH shell seam.
 *
 * Codex-shaped command execution over the DSH shell seam. Commands run through
 * the configured host shell and expose the familiar exec_command/write_stdin
 * interface; sandbox and approval behavior remains owned by DSH.
 *
 * Alignment surface (official -> here):
 * - schema: exec_command (cmd required; workdir/tty/yield_time_ms/
 *   max_output_tokens/shell/login) and write_stdin (session_id required;
 *   chars/yield_time_ms/max_output_tokens), descriptions verbatim, output schema = the official
 *   unified_exec_output_schema ({chunk_id, wall_time_seconds, exit_code,
 *   session_id, original_token_count, output}; required wall_time_seconds +
 *   output).
 * - result text: "Chunk ID: {id}" → "Wall time: {x:.4} seconds" →
 *   "Process exited with code N" → "Process running with session ID N" →
 *   "Original token count: N" → "Output:" → body (context.rs response_header
 *   + response_text as of rust-v0.153.4; body is re-truncated so header+body
 *   fit truncation_policy * 1.2).
 * - truncation: 1 MiB collection cap with head/tail retention and the
 *   "... N bytes omitted ..." marker (head_tail_buffer.rs), then middle
 *   truncation to the token budget with "…N tokens truncated…" and the
 *   "Warning: truncated output (original token count: N)\nTotal output
 *   lines: L\n\n..." prefix (output-truncation + utils/string/truncate.rs).
 * - yields: exec_command clamps 250-30000 ms (Windows floor 10000 ms, the
 *   deployment platform), write_stdin polls 5000-300000 ms, writes
 *   250-30000 ms (process_manager.rs).
 * - sessions: random ids in 1000..100000 (process_manager.rs
 *   random_range(1_000..100_000)), MAX_UNIFIED_EXEC_PROCESSES = 64 with LRU
 *   eviction (exited processes first) instead of a hard error.
 * - write_stdin: \u0003 interrupts (the seam kills the process; signal-death
 *   renders no exit-code section like the Option<exit_code> path); ANY other
 *   non-empty chars are an error with the official message "write_stdin
 *   failed: stdin is closed for this session; rerun exec_command with
 *   tty=true to keep stdin open" (errors.rs StdinClosed).
 * - exec_command intercepts whole-command apply_patch argv/heredoc forms and
 *   runs them through apply_patch (maybe_parse_apply_patch); failures are
 *   "exec_command failed: {err}" truncated to 900 bytes (truncate_middle_chars).
 *
 * @module dsh-codex/tools/exec-command
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { omitBlank } from './echo-noise.js?v=2'
import { applyPatchText, formatApplyPatchOutput, parsePatch } from './apply-patch.js'

export const name = 'tool-codex-exec'
export const inject = ['tools', 'shell', 'fs']

const APPLY_PATCH_IMPLICIT_MESSAGE =
  'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
const EXEC_COMMAND_REJECTION_MAX_BYTES = 900

const MAX_SESSIONS_PER_OWNER = 64 // codex MAX_UNIFIED_EXEC_PROCESSES
const MIN_YIELD_TIME_MS = 250
const MAX_YIELD_TIME_MS = 30000
const WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS = 10000
const MIN_EMPTY_YIELD_TIME_MS = 5000
const MAX_EMPTY_YIELD_TIME_MS = 300000
const MIN_WRITE_YIELD_TIME_MS = 250
const MAX_WRITE_YIELD_TIME_MS = 30000
const DEFAULT_YIELD_TIME_MS = 10000
const DEFAULT_MAX_OUTPUT_TOKENS = 10000 // codex DEFAULT_MAX_OUTPUT_TOKENS
const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024 // 1 MiB collection cap
const APPROX_BYTES_PER_TOKEN = 4
const POLL_INTERVAL_MS = 100

/** Accepted model-facing `shell` values; all map to the host git-bash executor.
 * POSIX names (`/bin/sh`, `/bin/bash`) are accepted because the cc-switch GPT
 * wire habitually echoes them — this deployment has exactly one shell, so the
 * aliases are harmless and keep the model out of failure loops. */
export const SHELL_VALUES = new Set(['bash', 'shell', 'git-bash', '/bin/sh', '/bin/bash'])

/**
 * Normalize a model-supplied `workdir` for the Windows host shell:
 * - MSYS/git-bash drive form `/d/...` → `D:\...` — the model (cc-switch GPT
 *   wire) routinely emits POSIX paths; passed through verbatim they make
 *   `spawn` fail with a misleading `spawn bash ENOENT` (on Windows an
 *   invalid cwd surfaces as ENOENT, not as a missing executable);
 * - relative paths resolve against the session cwd (predictable, instead of
 *   dangling off the server's own cwd);
 * - anything else (drive-letter absolute, UNC) passes through, with forward
 *   slashes canonicalized to backslashes on Windows (Windows accepts both,
 *   but one canonical shape keeps preflight stat/error messages predictable).
 */
export function normalizeWorkdir(value, sessionCwd) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  let path = value.trim()
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])\/(.*)$/.exec(path)
    if (msys !== null) path = `${msys[1].toUpperCase()}:\\${msys[2]}`
    // Canonical separator form: Windows accepts forward slashes, but one
    // canonical shape keeps preflight stat/error messages predictable.
    path = path.replace(/\//g, '\\')
  }
  if (!isAbsolute(path)) path = resolvePath(sessionCwd, path)
  return path
}

/**
 * Detect an `apply_patch` invocation embedded in `exec_command.cmd`.
 * Conservative port of maybe_parse_apply_patch (invocation.rs): only the
 * whole-command forms Codex intercepts — a quoted/unquoted argv body, or a
 * single-statement heredoc (`apply_patch <<EOF` / `cd <path> && apply_patch <<EOF`).
 * Trailing/leading extra commands do not match.
 *
 * @returns {{ kind: 'none' } | { kind: 'implicit' } | { kind: 'body', patch: string, workdir?: string }}
 */
export function parseEmbeddedApplyPatch(cmd) {
  if (typeof cmd !== 'string' || cmd.trim().length === 0) return { kind: 'none' }
  const text = cmd.replace(/\r\n/g, '\n').trim()
  try {
    parsePatch(text)
    return { kind: 'implicit' }
  } catch {
    // Not a raw patch body.
  }

  const quoted = /^(apply_patch|applypatch)\s+(['"])([\s\S]*)\2\s*$/.exec(text)
  if (quoted) return { kind: 'body', patch: quoted[3] }

  const unquoted = /^(apply_patch|applypatch)\s+([\s\S]+)$/.exec(text)
  if (unquoted && !unquoted[2].startsWith('<<')) {
    try {
      parsePatch(unquoted[2])
      return { kind: 'body', patch: unquoted[2] }
    } catch {
      // Fall through to heredoc / none.
    }
  }

  const heredoc =
    /^(?:cd\s+(?<cd>(?:'[^']+'|"[^"]+"|\S+))\s*&&\s*)?(?:apply_patch|applypatch)\s*<<[-]?(?<q>['"]?)(?<tag>\w+)\k<q>\n(?<body>[\s\S]*?)\n\k<tag>\s*$/.exec(
      text
    )
  if (heredoc) {
    const rawCd = heredoc.groups.cd
    const workdir = rawCd === undefined ? undefined : rawCd.replace(/^(['"])(.*)\1$/, '$2')
    return workdir === undefined ? { kind: 'body', patch: heredoc.groups.body } : { kind: 'body', patch: heredoc.groups.body, workdir }
  }
  return { kind: 'none' }
}

/** Format an exec_command rejection the way Codex does as of rust-v0.153.4. */
export function formatExecCommandFailure(err) {
  const detail = err instanceof Error ? err.message : String(err)
  return `exec_command failed: ${truncateMiddle(detail, EXEC_COMMAND_REJECTION_MAX_BYTES, false)}`
}

/**
 * Resolve the model-facing `workdir` into a spawnable absolute path and
 * pre-flight it: a nonexistent directory would otherwise surface as a bare
 * `spawn bash ENOENT` (Windows invalid-cwd semantics) with no hint of the
 * cause — the clear error names the original value and the fix.
 */
export function resolveWorkdir(value, sessionCwd) {
  const normalized = normalizeWorkdir(value, sessionCwd)
  if (normalized === undefined) return undefined
  let isDirectory = false
  try {
    isDirectory = statSync(normalized).isDirectory()
  } catch {}
  if (!isDirectory) {
    const resolved = normalized !== value ? ` (resolved to ${normalized})` : ''
    throw new Error(
      `workdir is not an existing directory: ${JSON.stringify(value)}${resolved}; ` +
        'pass a Windows path such as D:\\path\\to\\dir, or omit workdir to use the session cwd'
    )
  }
  return normalized
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
}

/** codex utils/string/src/truncate.rs approx_token_count: ceil(bytes/4). */
export function approxTokens(text) {
  const bytes = Buffer.byteLength(String(text), 'utf8')
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN)
}

/** codex utils/string/src/truncate.rs approx_bytes_for_tokens. */
export function approxBytesForTokens(tokens) {
  return tokens * APPROX_BYTES_PER_TOKEN
}

/**
 * Port of truncate_with_byte_estimate + split_string + split_budget
 * (utils/string/src/truncate.rs): keep head and tail around a marker
 * "…{N} tokens truncated…" (useTokens) or "…{N} chars truncated…".
 * @param {string} text - input text.
 * @param {number} maxBytes - byte budget for the retained head+tail.
 * @param {boolean} useTokens - marker/removed-count unit.
 */
export function truncateMiddle(text, maxBytes, useTokens) {
  if (text === '') return ''
  if (maxBytes <= 0) {
    const removedBytes = Buffer.byteLength(text, "utf8")
    const marker = useTokens
      ? `…${approxTokensFromBytes(removedBytes)} tokens truncated…`
      : `…${[...text].length} chars truncated…`
    return marker
  }
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return text
  const leftBudget = Math.floor(maxBytes / 2)
  const rightBudget = maxBytes - leftBudget
  const totalBytes = bytes
  const removedChars = [];
  let prefixEnd = 0
  let suffixStart = bytes
  let suffixStarted = false
  const tailStartTarget = totalBytes - rightBudget;
  let bytePos = 0
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, "utf8")
    const charEnd = bytePos + charBytes;
    if (charEnd <= leftBudget) { prefixEnd = charEnd; bytePos = charEnd; continue }
    if (bytePos >= tailStartTarget) {
      if (!suffixStarted) { suffixStart = bytePos; suffixStarted = true }
      bytePos = charEnd; continue
    }
    removedChars.push(ch)
    bytePos = charEnd
  }
  if (suffixStart < prefixEnd) suffixStart = prefixEnd
  const before = text.slice(0, prefixEnd)
  const after = text.slice(suffixStart)
  const removedBytes = totalBytes - (Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8"))
  const marker = useTokens
    ? `…${approxTokensFromBytes(removedBytes)} tokens truncated…`
    : `…${removedChars.length} chars truncated…`
  return before + marker + after
}

function approxTokensFromBytes(bytes) {
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN)
}

/**
 * formatted_truncate_text (utils/output-truncation/src/lib.rs): the
 * "Warning: truncated output" prefix used when the token budget is hit.
 */
export function formattedTruncateText(content, maxTokens) {
  if (Buffer.byteLength(content, 'utf8') <= approxBytesForTokens(maxTokens)) return content
  const originalTokenCount = approxTokens(content)
  const totalLines = countLines(content)
  const result = truncateMiddle(content, approxBytesForTokens(maxTokens), true)
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${result}`
}

/** Rust str::lines() line count (a trailing newline does not open an extra line). */
function countLines(text) {
  if (text === '') return 0
  let count = 0
  let start = 0
  for (;;) {
    const nl = text.indexOf("\n", start)
    if (nl === -1) {
      if (start < text.length) count++
      break
    }
    count++
    start = nl + 1
  }
  return count
}

/**
 * codex unified_exec/head_tail_buffer.rs: capped collection retaining a
 * 50/50 head+tail with omitted-bytes accounting.
 */
class HeadTailBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.headBudget = Math.floor(maxBytes / 2)
    this.tailBudget = maxBytes - this.headBudget
    this.head = []
    this.tail = []
    this.tailBytes = 0
    this.omittedBytes = 0
    this.totalBytes = 0
  }
  push(chunk) {
    if (chunk.length === 0) return
    this.totalBytes += Buffer.byteLength(chunk, "utf8")
    if (this.maxBytes <= 0) { this.omittedBytes += Buffer.byteLength(chunk, "utf8"); return }
    const headBytes = this.head.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0)
    const remainingHead = this.headBudget - headBytes;
    if (remainingHead > 0) {
      const headPart = chunk.slice(0, remainingHead);
      this.head.push(headPart);
      const rest = chunk.slice(remainingHead);
      this.pushToTail(rest);
    } else {
      this.pushToTail(chunk);
    }
  }
  pushToTail(chunk) {
    if (chunk.length === 0) return
    this.tail.push(chunk);
    this.tailBytes += Buffer.byteLength(chunk, "utf8");
    while (this.tailBytes > this.tailBudget) {
      const first = this.tail.shift();
      if (first === undefined) break
      const fb = Buffer.byteLength(first, "utf8");
      this.tailBytes -= fb;
      this.omittedBytes += fb;
    }
  }
  toTextWithOmissionMarker() {
    const head = this.head.join("");
    const tail = this.tail.join("");
    if (this.omittedBytes === 0) return head + tail
    return `${head}\n... ${this.omittedBytes} bytes omitted ...\n${tail}`
  }
  get totalObservedBytes() {
    return this.totalBytes
  }
}

/**
 * The model-facing body of the result: truncated_output() port
 * (core/src/tools/context.rs:412-440), given the capped text, the token
 * budget and the omitted-bytes metadata.
 */
export function truncatedOutputBody(value) {
  if (!value.truncated) return value.output
  const maxTokens = value.model_output_max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const omitted = value.output_omitted_bytes ?? 0
  const text = value.output
  if (omitted > 0) {
    const marker = `... ${omitted} bytes omitted ...`
    if (Buffer.byteLength(text, "utf8") <= approxBytesForTokens(maxTokens)) {
      return text.includes(marker) ? text : `${marker}\n${text}`
    }
    const originalTokenCount = value.original_token_count ?? approxTokens(text)
    const truncated = truncateMiddle(text, approxBytesForTokens(maxTokens), true)
    const omissionNotice = truncated.includes(marker) ? "" : `${marker}\n`
    return `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated}`
  }
  return formattedTruncateText(text, maxTokens)
}

/**
 * Render the metadata header of an exec result — response_header()
 * (core/src/tools/context.rs as of rust-v0.153.4): Chunk ID → Wall time
 * (4 decimals) → Process exited with code → Process running with session ID
 * → Original token count → "Output:".
 */
export function renderExecHeader(value) {
  const sections = []
  if (typeof value.chunk_id === "string" && value.chunk_id !== "") {
    sections.push(`Chunk ID: ${value.chunk_id}`)
  }
  sections.push(`Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`)
  if (value.exit_code !== undefined && value.exit_code !== null) {
    sections.push(`Process exited with code ${value.exit_code}`)
  }
  if (value.session_id !== undefined) {
    sections.push(`Process running with session ID ${value.session_id}`)
  }
  if (value.original_token_count !== undefined && value.original_token_count !== null) {
    sections.push(`Original token count: ${value.original_token_count}`)
  }
  sections.push('Output:')
  return sections.join('\n')
}

/**
 * Render the codex-parity tool result text — response_text() as of
 * rust-v0.153.4: header, then a body truncated so header + body fit
 * `truncation_policy * 1.2` (minus header length and the joining newline).
 */
export function renderExecResult(value) {
  const header = renderExecHeader(value)
  const serializationTokens = value.serialization_max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const outputBudget = Math.max(
    0,
    approxBytesForTokens(Math.ceil(serializationTokens * 1.2)) - Buffer.byteLength(header, 'utf8') - 1
  )
  const requested = value.model_output_max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  let policyTokens = Math.min(requested, serializationTokens)
  const bodyFor = (tokens) =>
    truncatedOutputBody({
      ...value,
      model_output_max_tokens: tokens,
      truncated: value.truncated || Buffer.byteLength(value.output ?? '', 'utf8') > approxBytesForTokens(tokens),
    })
  let output = bodyFor(policyTokens)
  while (Buffer.byteLength(output, 'utf8') > outputBudget && policyTokens > 0) {
    const excessBytes = Buffer.byteLength(output, 'utf8') - outputBudget
    policyTokens = Math.max(0, policyTokens - approxTokensFromBytes(excessBytes))
    output = bodyFor(policyTokens)
  }
  return `${header}\n${output}`
}

function generateChunkId() {
  let out = ""
  for (let i = 0; i < 6; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

/** One live background session, keyed by the numeric id the model sees. */
class ExecSession {
  constructor(proc, owner) {
    this.proc = proc
    this.owner = owner
    this.total = ""
    this.delivered = 0
    this.exitCode = null
    this.killed = false
    this.lossyNoted = false
  }
}

/**
 * Per-owner registry of live exec sessions. Session ids are random in
 * 1000..100000 (codex process_manager.rs); at the 64-process cap the
 * least-recently-used process is evicted (exited ones first), matching
 * prune_processes_if_needed — the call never fails.
 */
class ExecRegistry {
  constructor(ctx) {
    this.ctx = ctx
    this.byOwner = new WeakMap()
  }
  forOwner(owner) {
    let entry = this.byOwner.get(owner)
    if (entry === undefined) {
      entry = { sessions: new Map(), order: [], cleanupInstalled: false }
      this.byOwner.set(owner, entry)
      if (!entry.cleanupInstalled) {
        entry.cleanupInstalled = true
        owner.ctx.effect(() => async () => {
          for (const session of entry.sessions.values()) await Promise.resolve(session.proc.kill()).catch(() => {})
          entry.sessions.clear()
        }, 'tool-codex-exec owner cleanup')
      }
    }
    return entry
  }
  alloc(owner, proc) {
    const entry = this.forOwner(owner)
    if (entry.sessions.size >= MAX_SESSIONS_PER_OWNER) this.evict(entry)
    let id = 0
    do { id = 1000 + Math.floor(Math.random() * 99000) } while (entry.sessions.has(id))
    const session = new ExecSession(proc, owner)
    entry.sessions.set(id, session)
    entry.order.push(id)
    return { id, session }
  }
  evict(entry) {
    // Prefer evicting an exited process; otherwise the LRU (oldest first).
    let victim = null
    for (const id of entry.order) {
      const session = entry.sessions.get(id)
      if (session !== undefined && settled(session.proc)) { victim = id; break }
    }
    if (victim === null) victim = entry.order[0]
    const session = entry.sessions.get(victim)
    if (session !== undefined) {
      void Promise.resolve(session.proc.kill()).catch(() => {})
      entry.sessions.delete(victim)
    }
    entry.order = entry.order.filter((id) => entry.sessions.has(id))
  }
  touch(owner, id) {
    const entry = this.forOwner(owner)
    entry.order = entry.order.filter((x) => x !== id)
    entry.order.push(id)
  }
  get(owner, id) {
    const session = this.forOwner(owner).sessions.get(id)
    if (session === undefined) throw new Error(`write_stdin failed: Unknown process id ${id}`)
    this.touch(owner, id)
    return session
  }
  release(owner, id) {
    const entry = this.forOwner(owner)
    entry.sessions.delete(id)
    entry.order = entry.order.filter((x) => x !== id)
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/** Strip ANSI escape noise (the seam may color output). */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

/** Drain one output read from a background process into the session/buffer. */
function drainOutput(proc, buffer, session) {
  let read
  try {
    read = proc.readOutput()
  } catch {
    return
  }
  const delta = typeof read?.delta === "string" ? stripAnsi(read.delta) : ""
  if (session !== undefined && read?.lossy && !session.lossyNoted) {
    session.lossyNoted = true
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p) => p !== undefined)
    session.total += `\n[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]\n`
  }
  if (session !== undefined) session.total += delta
  if (buffer !== undefined) buffer.push(delta)
}

/** Whether the background process has settled. */
function settled(proc) {
  return (
    proc.status === 'completed' ||
    proc.status === 'exited' ||
    proc.status === 'killed' ||
    proc.status === 'closed'
  )
}

/** Wait until the process settles or the deadline passes. */
async function waitSettled(proc, deadline) {
  for (;;) {
    if (settled(proc)) return proc.status
    if (Date.now() >= deadline) return undefined
    const race = await Promise.race([proc.done.then(() => 'settled'), pause().then(() => 'tick')])
    if (race === 'settled') return proc.status
  }
}

/**
 * The exec_command model-facing description.
 *
 * Intentionally NOT the official shell_spec.rs win32 text: its "Windows
 * safety rules" paragraph presumes a PowerShell host and misleads the model
 * on this deployment, whose only shell is git bash (repro 2026-09-03:
 * gpt-5.6 sent shell:"powershell.exe" and every call was rejected).
 */
const EXEC_COMMAND_DESCRIPTION =
  'Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n' +
  'This deployment provides exactly one shell: git bash. Write POSIX bash syntax; ' +
  'only the `shell` values listed in the shell parameter are accepted.'

/** The exec output schema shared by both tools (shell_spec.rs unified_exec_output_schema). */
const execOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    chunk_id: { type: "string", description: "Chunk identifier included when the response reports one." },
    wall_time_seconds: { type: "number", required: true, description: "Elapsed wall time spent waiting for output in seconds." },
    exit_code: { type: "number", description: "Process exit code when the command finished during this call." },
    session_id: { type: "number", description: "Session identifier to pass to write_stdin when the process is still running." },
    original_token_count: { type: "number", description: "Approximate token count before output truncation." },
    output: { type: "string", required: true, description: "Command output text, possibly truncated." },
    // DSH-internal transport only (never serialized to the model wire — the
    // wire carries the rendered text): the official schema ends at `output`.
    truncated: { type: "boolean" },
    output_omitted_bytes: { type: "number" },
    model_output_max_tokens: { type: "number" },
  },
}

/**
 * Resolve the model-visible token budget: min(resolve_max_tokens(arg),
 * truncation_policy.token_budget()) — both default to 10000 (unified_exec
 * mod.rs resolve_max_tokens; models.json truncation limit 10000).
 */
function resolveModelOutputMaxTokens(args, config) {
  const requested = Number(args.max_output_tokens)
  const resolved = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : DEFAULT_MAX_OUTPUT_TOKENS
  const policyBudget = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(resolved, policyBudget)
}

/** Drop own keys whose value is undefined (DSH walkJsonValue rejects undefined-valued properties). */
function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

/** ExecCommandToolOutput builder: cap collection, truncate, and stamp metadata. */
function buildOutput(session, buffer, maxTokens, settledNow) {
  const capped = buffer.toTextWithOmissionMarker()
  const outputOmittedBytes = buffer.omittedBytes > 0 ? buffer.omittedBytes : undefined
  const originalTokenCount = approxTokensFromBytes(buffer.totalObservedBytes)
  const truncated = Buffer.byteLength(capped, "utf8") > approxBytesForTokens(maxTokens)
  return {
    output: capped,
    truncated,
    original_token_count: originalTokenCount,
    output_omitted_bytes: outputOmittedBytes,
    model_output_max_tokens: maxTokens,
  }
}

/**
 * The session-scoped output budget: the seam may drop output to spill
 * files, but the buffer keeps the first/last 1 MiB like codex.
 */
function makeBuffer(config) {
  return new HeadTailBuffer(config.maxOutputBytes ?? UNIFIED_EXEC_OUTPUT_MAX_BYTES)
}

function registerExecCommand(ctx, config) {
  const registry = new ExecRegistry(ctx)

  const execCommand = defineTool({
    name: 'exec_command',
    description: EXEC_COMMAND_DESCRIPTION,
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
      yield_time_ms: {
        type: 'number',
        description:
          'Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms.',
      },
      max_output_tokens: {
        type: 'number',
        description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.',
      },
      shell: {
        type: 'string',
        description:
          'Shell to use; this deployment only provides git bash, so only these values are accepted: ' +
          [...SHELL_VALUES].join(', ') + '. Omit to use the default.',
      },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
    },
    output: {
      schema: execOutputSchema,
      render: (_args, value) => [{ type: "text", text: renderExecResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('exec_command requires an owning agent session')
      if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty string')
      // Blank optional strings are treated as omitted by the DSH adapter.
      args = omitBlank(args, 'shell')
      args = omitBlank(args, 'workdir')
      if (args.shell !== undefined && !SHELL_VALUES.has(args.shell))
        throw new Error(`unsupported shell "${args.shell}": this deployment only provides git bash (bash/shell/git-bash)`)

      const floor = config.yieldFloorMs ?? (process.platform === 'win32' ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS : MIN_YIELD_TIME_MS)
      const yieldMs = clamp(args.yield_time_ms, floor, MAX_YIELD_TIME_MS, DEFAULT_YIELD_TIME_MS)
      const maxTokens = resolveModelOutputMaxTokens(args, config)
      const sessionCwd = owner.session.header.cwd
      const embedded = parseEmbeddedApplyPatch(args.cmd)
      if (embedded.kind === 'implicit') throw new Error(APPLY_PATCH_IMPLICIT_MESSAGE)
      if (embedded.kind === 'body') {
        const patchCwd = embedded.workdir
          ? (normalizeWorkdir(embedded.workdir, sessionCwd) ?? sessionCwd)
          : (normalizeWorkdir(args.workdir, sessionCwd) ?? sessionCwd)
        const applied = await applyPatchText(ctx, embedded.patch, patchCwd)
        return compact({
          chunk_id: '',
          wall_time_seconds: 0,
          output: formatApplyPatchOutput(applied),
          truncated: false,
          model_output_max_tokens: maxTokens,
        })
      }

      const cwd = resolveWorkdir(args.workdir, sessionCwd) ?? sessionCwd
      const start = Date.now()

      let proc
      try {
        proc = startShell(ctx, exec, args.cmd, cwd)
      } catch (error) {
        throw new Error(formatExecCommandFailure(error))
      }
      const onAbort = () => {
        if (!settled(proc)) void Promise.resolve(proc.kill()).catch(() => {})
      }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const buffer = makeBuffer(config)
        const deadlineEnd = Date.now() + yieldMs
        while (!settled(proc)) {
          drainOutput(proc, buffer)
          const status = await waitSettled(proc, deadlineEnd)
          if (status !== undefined) break
          if (Date.now() >= deadlineEnd) break
          if (exec.signal.aborted) exec.signal.throwIfAborted()
        }
        drainOutput(proc, buffer)
        const wallTime = (Date.now() - start) / 1000
        const chunkId = generateChunkId()
        if (settled(proc)) {
          const output = buildOutput(null, buffer, maxTokens)
          return compact({
            chunk_id: chunkId,
            ...(proc.exitCode !== null && proc.exitCode !== undefined ? { exit_code: proc.exitCode } : {}),
            wall_time_seconds: wallTime,
            output: output.output,
            truncated: output.truncated,
            original_token_count: output.original_token_count,
            output_omitted_bytes: output.output_omitted_bytes,
            model_output_max_tokens: maxTokens,
          })
        }
        const { id } = registry.alloc(owner, proc)
        const output = buildOutput(null, buffer, maxTokens)
        return compact({
          chunk_id: chunkId,
          session_id: id,
          wall_time_seconds: wallTime,
          output: output.output,
          truncated: output.truncated,
          original_token_count: output.original_token_count,
          output_omitted_bytes: output.output_omitted_bytes,
          model_output_max_tokens: maxTokens,
        })
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
    presentCall: (args) => ({ card: 'terminal', title: args.cmd }),
  })

  const writeStdin = defineTool({
    name: 'write_stdin',
    description: 'Writes characters to an existing unified exec session and returns recent output.',
    parameters: {
      session_id: { type: 'number', required: true, description: 'Identifier of the running unified exec session.' },
      chars: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
      yield_time_ms: {
        type: 'number',
        description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.',
      },
      max_output_tokens: {
        type: 'number',
        description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.',
      },
    },
    output: {
      schema: execOutputSchema,
      render: (_args, value) => [{ type: "text", text: renderExecResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('write_stdin requires an owning agent session')
      const session = registry.get(owner, args.session_id)
      const chars = typeof args.chars === 'string' ? args.chars : ''
      const isPoll = chars.length === 0
      // Codex stdin semantics on a non-PTY session (process_manager.rs:784-811):
      // the only writable byte is \u0003 (interrupt); anything else is the
      // StdinClosed error — never a silent success.
      if (!isPoll) {
        if (chars !== '\u0003') {
          throw new Error(
            'write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open'
          )
        }
        if (!settled(session.proc)) await Promise.resolve(session.proc.kill()).catch(() => {})
      }
      const yieldMs = clamp(
        args.yield_time_ms,
        isPoll ? MIN_EMPTY_YIELD_TIME_MS : MIN_WRITE_YIELD_TIME_MS,
        isPoll ? MAX_EMPTY_YIELD_TIME_MS : MAX_WRITE_YIELD_TIME_MS,
        isPoll ? MIN_EMPTY_YIELD_TIME_MS : MIN_WRITE_YIELD_TIME_MS
      )
      const maxTokens = resolveModelOutputMaxTokens(args, config)
      const start = Date.now()
      const buffer = new HeadTailBuffer(config.maxOutputBytes ?? UNIFIED_EXEC_OUTPUT_MAX_BYTES)
      // The buffer accumulates only the NEW output for this call.
      const deadlineEnd = Date.now() + yieldMs
      while (!settled(session.proc)) {
        drainOutput(session.proc, buffer, session)
        const status = await waitSettled(session.proc, deadlineEnd)
        if (status !== undefined) break
        if (Date.now() >= deadlineEnd) break
        if (exec.signal.aborted) exec.signal.throwIfAborted()
      }
      drainOutput(session.proc, buffer, session)
      const wallTime = (Date.now() - start) / 1000
      const chunkId = generateChunkId()
      if (settled(session.proc)) {
        session.exitCode = session.proc.exitCode ?? null
        session.killed = session.proc.status === "killed"
        registry.release(owner, args.session_id)
        const output = buildOutput(null, buffer, maxTokens)
        return compact({
          chunk_id: chunkId,
          ...(session.exitCode !== null && session.exitCode !== undefined ? { exit_code: session.exitCode } : {}),
          wall_time_seconds: wallTime,
          output: output.output,
          truncated: output.truncated,
          original_token_count: output.original_token_count,
          output_omitted_bytes: output.output_omitted_bytes,
          model_output_max_tokens: maxTokens,
        })
      }
      const output = buildOutput(null, buffer, maxTokens)
      return compact({
        chunk_id: chunkId,
        wall_time_seconds: wallTime,
        output: output.output,
        truncated: output.truncated,
        original_token_count: output.original_token_count,
        output_omitted_bytes: output.output_omitted_bytes,
        model_output_max_tokens: maxTokens,
      })
    },
    presentCall: (args) => ({ card: 'terminal', title: `write_stdin → session ${args.session_id}` }),
  })

  ctx.tools.register(execCommand)
  ctx.tools.register(writeStdin)
}

/** Start one command through the host shell seam (git bash on this profile). */
function startShell(ctx, exec, command, cwd) {
  const shellEnv = ctx.get('shellEnv')
  const dshEnv = shellEnv !== undefined ? shellEnv.collect(exec) : undefined
  const request = {
    command,
    ...(cwd === undefined ? {} : { workdir: cwd }),
    ...(dshEnv === undefined ? {} : { dshEnv }),
  }
  const resolved = ctx.shell.resolve(request)
  return ctx.shell.start(resolved)
}

export const Config = z.object({
  maxOutputBytes: z.number().step(1).min(1).default(UNIFIED_EXEC_OUTPUT_MAX_BYTES),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_TOKENS),
  /** exec_command yield floor; codex floors at 10000 ms on Windows. */
  yieldFloorMs: z.number().step(1).min(1),
})

export function apply(ctx, config) {
  const resolved = {
    maxOutputBytes: config.maxOutputBytes ?? UNIFIED_EXEC_OUTPUT_MAX_BYTES,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    yieldFloorMs: config.yieldFloorMs ?? (process.platform === 'win32' ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS : MIN_YIELD_TIME_MS),
  }
  registerExecCommand(ctx, resolved)
}
