/**
 * dsh-codex M1 — `exec_command` + `write_stdin` over the DSH shell seam.
 *
 * Codex-parity implementation (HEAD 5bc8da6d78): schemas and descriptions from
 * shell_spec.rs, execution semantics from unified_exec (process_manager.rs),
 * and the model-facing result text from context.rs response_text()/
 * truncated_output(). The execution backend per decision D1-R2: the PTY seam
 * is UNAVAILABLE on this deployment (win32: `subprocess-local` has no process
 * inspector, so `ctx.terminals.spawn` fails), so commands run through the
 * host `ctx.shell` seam — the same git-bash executor the DSH `bash` tool
 * uses. The model still never sees the raw `bash` tool (tool-codex-restrict
 * denies it): every command passes the codex approval gate below.
 *
 * Alignment surface (official -> here):
 * - schema: exec_command (cmd required; workdir/tty/yield_time_ms/
 *   max_output_tokens/shell/login/sandbox_permissions/justification/
 *   prefix_rule) and write_stdin (session_id required; chars/yield_time_ms/
 *   max_output_tokens), descriptions verbatim, output schema = the official
 *   unified_exec_output_schema ({chunk_id, wall_time_seconds, exit_code,
 *   session_id, original_token_count, output}; required wall_time_seconds +
 *   output).
 * - escalation (2026-08-16 dsh adaptation): codex's sandbox concept is a real
 *   OS isolation layer (seatbelt/landlock/bwrap/restricted-token) that dsh
 *   does NOT replicate — exec_command runs through the host shell seam under
 *   the DSH sandbox policy. The model-facing escalation vocabulary
 *   (sandbox_permissions/justification/prefix_rule) is therefore meaningful
 *   ONLY when the DSH host sandbox is actually restricted AND the approval
 *   policy can prompt; outside that window the fields are inert model echo
 *   noise — accepted and ignored, never hard-failing the call. Inside it, the
 *   codex pairing rule (justification ⇔ require_escalated) and approval flow
 *   apply unchanged, and an approved `prefix_rule` seeds a session-level
 *   approval cache so matching commands skip the gate.
 * - result text: "Chunk ID: {id}" → "Wall time: {x:.4} seconds" →
 *   "Process exited with code N" → "Process running with session ID N" →
 *   "Original token count: N" → "Output:" → body (context.rs:442-468).
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
 *
 * @module dsh-codex/tools/exec-command
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { omitBlank } from './echo-noise.js?v=2'
import { DECISION, classify, tokenize } from '../policy/exec-policy.js'

export const name = 'tool-codex-exec'
export const inject = ['tools', 'shell']

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

/** Accepted model-facing `shell` values; all map to the host git-bash executor. */
const SHELL_VALUES = new Set(['bash', 'shell', 'git-bash'])

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
 * Render the codex-parity tool result text — response_text()
 * (core/src/tools/context.rs:442-468): Chunk ID → Wall time (4 decimals)
 * → Process exited with code → Process running with session ID →
 * Original token count → "Output:" → body.
 */
export function renderExecResult(value) {
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
  sections.push(truncatedOutputBody(value))
  return sections.join("\n")
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
 * The exec_command model-facing description (shell_spec.rs, win32 form
 * with the Windows safety rules).
 */
const EXEC_COMMAND_DESCRIPTION =
  'Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n' +
  'Windows safety rules:\n' +
  '- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.\n' +
  '- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.\n' +
  '- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.'

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
      shell: { type: 'string', description: 'Shell binary to launch. Defaults to the user\'s default shell.' },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
      sandbox_permissions: {
        type: 'string',
        enum: ['use_default', 'require_escalated'],
        description: 'Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.',
      },
      justification: { type: 'string', description: 'User-facing approval question for `require_escalated`; omit otherwise.' },
      prefix_rule: {
        type: 'array',
        description:
          'Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
        items: { type: 'string' },
      },
    },
    output: {
      schema: execOutputSchema,
      render: (_args, value) => [{ type: "text", text: renderExecResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('exec_command requires an owning agent session')
      if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty string')
      // Blank echo fields are treated as omitted: models routinely echo the
      // schema's optional string fields as "" (shell/workdir/justification),
      // which must not hard-fail the call (echo-noise.js normalization).
      args = omitBlank(args, 'shell')
      args = omitBlank(args, 'workdir')
      if (args.shell !== undefined && !SHELL_VALUES.has(args.shell))
        throw new Error(`unsupported shell "${args.shell}": this deployment only provides git bash (bash/shell/git-bash)`)

      // Adaptive escalation (2026-08-16): the codex sandbox vocabulary is only
      // meaningful when the DSH host sandbox is actually restricted AND the
      // approval policy can prompt. Outside that window (full access, or
      // approval `never`) the fields are inert model echo noise — accepted and
      // ignored, never hard-failing the call. Inside it, the codex pairing
      // rule and the approval flow apply unchanged.
      const escalation = resolveEscalation(ctx, owner, config, args, registry.forOwner(owner))

      await applyApprovalGate(ctx, owner, exec, args, config, escalation)
      const floor = config.yieldFloorMs ?? (process.platform === 'win32' ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS : MIN_YIELD_TIME_MS)
      const yieldMs = clamp(args.yield_time_ms, floor, MAX_YIELD_TIME_MS, DEFAULT_YIELD_TIME_MS)
      const maxTokens = resolveModelOutputMaxTokens(args, config)
      const cwd = args.workdir !== undefined ? args.workdir : owner.session.header.cwd
      const start = Date.now()

      const proc = startShell(ctx, exec, args.cmd, cwd)
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
  /** Codex approval policy applied when the session policy is `ask` ('on-request' default). */
  policy: z.union([z.const('on-request'), z.const('untrusted'), z.const('never')]).default('on-request'),
})

/**
 * Resolve the effective codex policy for one call: a session-level `never`
 * wins (codex `never` semantics — what would prompt is forbidden), otherwise
 * the plugin-configured policy applies.
 */
function effectiveCodexPolicy(ctx, owner, config) {
  const approval = ctx.get('approval')
  const sessionPolicy = approval?.overrideOf?.(owner.session) ?? approval?.config?.policy
  if (sessionPolicy === 'never') return 'never'
  return config.policy
}

function sandboxRestricted(ctx) {
  const fs = ctx.get('fs')
  const mode = fs?.sandboxMode
  return mode !== undefined && mode !== 'danger-full-access'
}

/** Whether argv starts with the session pre-approved prefix token list. */
function matchesPrefix(argv, prefix) {
  if (prefix.length === 0 || argv.length < prefix.length) return false
  return prefix.every((token, i) => argv[i] === token)
}

/**
 * Whether the codex escalation vocabulary is LIVE in this session. Escalation
 * means "run wider than a restricted sandbox", which only exists when the DSH
 * host sandbox is actually restricted AND the approval policy can prompt (a
 * session-level or configured `never` disables every prompt). This is the DSH
 * adaptation of codex's sandbox concept: the OS-isolation half is not
 * replicated, so the model-facing escalation fields are meaningful only where
 * DSH's own restricted-sandbox + approval seam can back them.
 */
function escalationLive(ctx, owner, config) {
  if (effectiveCodexPolicy(ctx, owner, config) === 'never') return false
  return sandboxRestricted(ctx)
}

/**
 * Resolve the escalation arguments into their effective meaning for ONE call.
 * Outside the live window every field is dropped (inert model echo noise —
 * the 2026-08-16 adaptation that replaced the always-on pairing error). Inside
 * it, the codex pairing rule is enforced (a non-blank `justification` requires
 * `require_escalated`; blank justification is treated as omitted) and the
 * session-approved-prefix cache is wired for `prefix_rule`.
 */
function resolveEscalation(ctx, owner, config, args, sessionEntry) {
  const prefixes = (sessionEntry.prefixes ??= [])
  const rawJustification = typeof args.justification === 'string' ? args.justification.trim() : undefined
  const requestsEscalation = args.sandbox_permissions === 'require_escalated'
  const prefixRule = Array.isArray(args.prefix_rule) ? args.prefix_rule.filter((token) => typeof token === 'string') : []
  if (!escalationLive(ctx, owner, config)) {
    return { live: false, requestsEscalation: false, justification: undefined, prefixRule: [], prefixes }
  }
  if (rawJustification !== undefined && rawJustification !== '' && !requestsEscalation) {
    throw new Error(
      '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.'
    )
  }
  return { live: true, requestsEscalation, justification: rawJustification, prefixRule, prefixes }
}

/**
 * Apply the codex policy layer before execution: forbidden throws, prompt
 * goes through the DSH approval seam (the same seam the bash tool's sandbox
 * escalation uses), allowed-once proceeds. A session pre-approved prefix
 * (codex `prefix_rule` approved together with an escalation request) lets
 * matching commands skip the gate.
 */
async function applyApprovalGate(ctx, owner, exec, args, config, escalation) {
  const argv = tokenize(args.cmd)
  if (escalation.live && escalation.prefixes.some((prefix) => matchesPrefix(argv, prefix))) return
  const decision = classify(argv, {
    policy: effectiveCodexPolicy(ctx, owner, config),
    sandboxRestricted: sandboxRestricted(ctx),
    requestsEscalation: escalation.live ? escalation.requestsEscalation : false,
    platform: process.platform,
  })
  if (decision.decision === DECISION.forbidden) {
    throw new Error(`command forbidden by approval policy: ${decision.reason}`)
  }
  if (decision.decision !== DECISION.prompt) return
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error('command requires approval but the approval service is unavailable')
  const reason =
    escalation.live && escalation.requestsEscalation
      ? (escalation.justification !== undefined && escalation.justification.length > 0
          ? escalation.justification
          : 'model requested escalation')
      : `command classified as ${decision.reason}`
  const outcome = await approval.request({
    agent: owner,
    toolName: 'exec_command',
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') {
    // An approved escalation may carry a reusable approval prefix: subsequent
    // commands starting with those tokens skip the gate for the session.
    if (escalation.live && escalation.requestsEscalation && escalation.prefixRule.length > 0) {
      escalation.prefixes.push(escalation.prefixRule)
    }
    return
  }
  if (outcome === 'rejected') throw new Error('command rejected by the user')
  throw new Error(`command approval unavailable (${outcome})`)
}

export function apply(ctx, config) {
  const resolved = {
    maxOutputBytes: config.maxOutputBytes ?? UNIFIED_EXEC_OUTPUT_MAX_BYTES,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    yieldFloorMs: config.yieldFloorMs ?? (process.platform === 'win32' ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS : MIN_YIELD_TIME_MS),
    policy: config.policy ?? "on-request",
  }
  registerExecCommand(ctx, resolved)
}