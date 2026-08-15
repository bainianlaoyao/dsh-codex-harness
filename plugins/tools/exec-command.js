/**
 * dsh-codex M1 — `exec_command` + `write_stdin` over the DSH shell seam.
 *
 * Codex-parity schemas (HEAD 5bc8da6d78, shell_spec.rs:21-155) with the
 * execution backend per decision D1-R2: the PTY seam is UNAVAILABLE on this
 * deployment (win32: `subprocess-local` has no process inspector, so
 * `ctx.terminals.spawn` fails with "terminal inspection is unsupported on
 * platform win32"). exec_command therefore executes through the host `ctx.shell`
 * seam — the same executor the DSH `bash` tool uses (on this profile:
 * bash-sandbox spawning git bash; pwsh disabled). The model still never sees
 * the raw `bash` tool (tool-codex-restrict denies it): every command passes
 * the codex approval gate below.
 *
 * Semantics:
 * - Every exec_command call starts a background shell process. Completion is
 *   awaited for up to `yield_time_ms`; if the process finishes, the tool
 *   returns the exit code and captured output. Otherwise the process is
 *   registered under a numeric session id and the tool returns
 *   `Process running with session ID N`; `write_stdin` then polls it (empty
 *   `chars` — returns only NEW output) or sends a control byte.
 * - The shell seam has no stdin pipe into a running background process, so
 *   `write_stdin` approximates codex on win32: `\u0003` (Ctrl-C) kills the
 *   process, other raw characters are reported as not deliverable (no PTY).
 * - Sessions are capped at 64 per owner (codex MAX_UNIFIED_EXEC_PROCESSES)
 *   and killed when the owning agent session is disposed.
 *
 * @module dsh-codex/tools/exec-command
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { DECISION, classify, tokenize } from '../policy/exec-policy.js'

export const name = 'tool-codex-exec'
export const inject = ['tools', 'shell']

const MAX_SESSIONS_PER_OWNER = 64
const MIN_YIELD_TIME_MS = 250
const MAX_YIELD_TIME_MS = 30000
const MIN_EMPTY_YIELD_TIME_MS = 5000
const MAX_EMPTY_YIELD_TIME_MS = 300000
const MIN_WRITE_YIELD_TIME_MS = 250
const MAX_WRITE_YIELD_TIME_MS = 30000
const DEFAULT_YIELD_TIME_MS = 10000
const DEFAULT_MAX_OUTPUT_CHARS = 1000000 // codex 1 MiB output cap
const POLL_INTERVAL_MS = 100

/** Accepted model-facing `shell` values; all map to the host bash executor (git bash here). */
const SHELL_VALUES = new Set(['bash', 'shell', 'git-bash'])

function pause() {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
}

/** One live background session, keyed by the numeric id the model sees. */
class ExecSession {
  constructor(proc, owner) {
    this.proc = proc
    this.owner = owner
    this.total = ''
    this.delivered = 0
    this.exitCode = null
    this.killed = false
    this.lossyNoted = false
  }
}

/** Per-owner registry of live exec sessions. */
class ExecRegistry {
  constructor(ctx) {
    this.ctx = ctx
    this.byOwner = new WeakMap()
  }
  forOwner(owner) {
    let entry = this.byOwner.get(owner)
    if (entry === undefined) {
      entry = { nextId: 1, sessions: new Map(), cleanupInstalled: false }
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
    if (entry.sessions.size >= MAX_SESSIONS_PER_OWNER)
      throw new Error(`too many background exec sessions (limit ${MAX_SESSIONS_PER_OWNER})`)
    const id = entry.nextId++
    const session = new ExecSession(proc, owner)
    entry.sessions.set(id, session)
    return { id, session }
  }
  get(owner, id) {
    const session = this.forOwner(owner).sessions.get(id)
    if (session === undefined) throw new Error(`unknown exec session ID ${id}`)
    return session
  }
  release(owner, id) {
    this.forOwner(owner).sessions.delete(id)
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/** Strip ANSI escape noise (commands may color output). */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

function truncateOutput(output, maxChars) {
  const body = stripAnsi(output)
  if (body.length <= maxChars) return { text: body, truncated: false }
  return { text: body.slice(0, maxChars), truncated: true }
}

/**
 * Render the codex-parity tool result text — byte-shape of codex HEAD
 * ExecCommandToolOutput::response_text() (core/src/tools/context.rs:442-468):
 * sections joined by "\n" in order: Wall time (4 decimals) → Process exited
 * with code → Process running with session ID → Original token count →
 * "Output:" → body. Truncation renders the official
 * "Warning: truncated output (original token count: N)" prefix before the
 * truncated body (context.rs:412-440). Signal deaths (exit_code null) render
 * no exit-code section, matching the Option<exit_code> behavior.
 */
export function renderExecResult(value) {
  const sections = []
  sections.push(`Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`)
  if (value.exit_code !== undefined && value.exit_code !== null) {
    sections.push(`Process exited with code ${value.exit_code}`)
  }
  if (value.session_id !== undefined) {
    sections.push(`Process running with session ID ${value.session_id}`)
  }
  if (value.truncated) {
    sections.push(`Original token count: ${value.original_token_count}`)
  }
  sections.push('Output:')
  const body = value.truncated
    ? `Warning: truncated output (original token count: ${value.original_token_count})\n${value.output}`
    : value.output
  return `${sections.join('\n')}\n${body}`
}

/**
 * Drain one output read from a background process into the session. Lossy
 * (spill-file) reads append a notice once.
 */
function drainOutput(session) {
  let read
  try {
    read = session.proc.readOutput()
  } catch {
    return
  }
  const delta = typeof read?.delta === 'string' ? read.delta : ''
  if (read?.lossy && !session.lossyNoted) {
    session.lossyNoted = true
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
    session.total += `\n[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]\n`
  }
  session.total += delta
}

/**
 * Whether the background process has settled. The host shell seam
 * (dsh-bash-local startArgv) reports a normally finished process as
 * `completed` — its status domain is `running | completed | killed`, so
 * without `completed` here every finished command was misread as still
 * running, exec_command wrongly returned "Process running with session ID",
 * and the model was forced into a payload-less write_stdin poll. The
 * `exited`/`closed` spellings are kept for mock processes and future
 * backends.
 */
function settled(proc) {
  return (
    proc.status === 'completed' ||
    proc.status === 'exited' ||
    proc.status === 'killed' ||
    proc.status === 'closed'
  )
}

/**
 * Wait until the process settles or the deadline passes. Returns the settled
 * status when done, else undefined.
 */
async function waitSettled(proc, deadline) {
  for (;;) {
    if (settled(proc)) return proc.status
    if (Date.now() >= deadline) return undefined
    const race = await Promise.race([proc.done.then(() => 'settled'), pause().then(() => 'tick')])
    if (race === 'settled') return proc.status
  }
}

function registerExecCommand(ctx, config) {
  const registry = new ExecRegistry(ctx)

  const execCommand = defineTool({
    name: 'exec_command',
    description:
      'PROPOSE a command to run. When the command does not finish within yield_time_ms, a session ID is returned and `write_stdin` polls it or writes raw stdin (e.g. control bytes). ' +
      'If you have this tool, note that you DO have the ability to run commands directly on the user\'s system.',
    parameters: {
      cmd: { type: 'string', required: true, description: 'The command to run.' },
      workdir: { type: 'string', description: 'Working directory (default: the current working directory).' },
      tty: { type: 'boolean', description: 'Requested for schema parity; ignored on the bash backend.' },
      yield_time_ms: {
        type: 'number',
        description: `How long to wait for completion before returning a session ID (default ${DEFAULT_YIELD_TIME_MS}, range ${MIN_YIELD_TIME_MS}-${MAX_YIELD_TIME_MS}).`,
      },
      max_output_tokens: {
        type: 'number',
        description: 'Maximum output tokens (default 10000); approximated by an output character budget.',
      },
      shell: {
        type: 'string',
        description:
          'Requested shell backend. This deployment runs git bash (the host bash executor); accepted values: bash, shell, git-bash.',
      },
      login: { type: 'boolean', description: 'Requested for schema parity; ignored.' },
      sandbox_permissions: {
        type: 'string',
        enum: ['use_default', 'with_additional_permissions', 'require_escalated'],
        description: 'Use "require_escalated" to explicitly request running outside the sandbox (with a justification).',
      },
      justification: { type: 'string', description: 'Required with require_escalated: why this command needs the wider access.' },
      prefix_rule: { type: 'array', description: 'Requested for schema parity; accepted and recorded.', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          original_token_count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('exec_command requires an owning agent session')
      if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty string')
      if (args.shell !== undefined && !SHELL_VALUES.has(args.shell))
        throw new Error(`unsupported shell "${args.shell}": this deployment only provides git bash (bash/shell/git-bash)`)
      await applyApprovalGate(ctx, owner, exec, args, config)
      const yieldMs = clamp(args.yield_time_ms, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS, DEFAULT_YIELD_TIME_MS)
      const maxChars = clamp(args.max_output_tokens, 100, MAX_EMPTY_YIELD_TIME_MS * 10, DEFAULT_MAX_OUTPUT_CHARS)
      const cwd = args.workdir !== undefined ? args.workdir : owner.session.header.cwd
      const start = Date.now()

      const proc = startShell(ctx, exec, args.cmd, cwd)
      const onAbort = () => {
        if (!settled(proc)) void Promise.resolve(proc.kill()).catch(() => {})
      }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const session = new ExecSession(proc, owner)
        const deadlineEnd = Date.now() + yieldMs
        while (!settled(proc)) {
          drainOutput(session)
          const status = await waitSettled(proc, deadlineEnd)
          if (status !== undefined) break
          if (Date.now() >= deadlineEnd) break
          if (exec.signal.aborted) exec.signal.throwIfAborted()
        }
        drainOutput(session)
        const wallTime = (Date.now() - start) / 1000
        if (settled(proc)) {
          session.exitCode = proc.exitCode ?? null
          session.killed = proc.status === 'killed'
          const output = truncateOutput(finalOutput(session), maxChars)
          return {
            exit_code: session.exitCode,
            wall_time_seconds: wallTime,
            output: output.text,
            truncated: output.truncated,
            original_token_count: Math.ceil(output.text.length / 4),
          }
        }
        const { id } = registry.alloc(owner, proc)
        session.delivered = session.total.length
        const output = truncateOutput(session.total, maxChars)
        return {
          session_id: id,
          wall_time_seconds: wallTime,
          output: output.text,
          truncated: output.truncated,
          original_token_count: Math.ceil(output.text.length / 4),
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
    presentCall: (args) => ({ card: 'terminal', title: args.cmd }),
  })

  const writeStdin = defineTool({
    name: 'write_stdin',
    description:
      'Write raw input (or a control byte) to a running exec session, or poll it for new output when `chars` is empty. Sessions finish on their own or after receiving Ctrl-C.',
    parameters: {
      session_id: { type: 'number', required: true, description: 'The session ID returned by exec_command.' },
      chars: { type: 'string', description: 'Raw stdin characters (e.g. "\\u0003" for Ctrl-C). Empty = poll for output.' },
      yield_time_ms: {
        type: 'number',
        description: `How long to wait for new output; empty polls default to ${MIN_EMPTY_YIELD_TIME_MS}-${MAX_EMPTY_YIELD_TIME_MS}ms, writes wait ${MIN_WRITE_YIELD_TIME_MS}-${MAX_WRITE_YIELD_TIME_MS}ms.`,
      },
      max_output_tokens: {
        type: 'number',
        description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit_code: { type: 'number' },
          wall_time_seconds: { type: 'number', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          original_token_count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined) throw new Error('write_stdin requires an owning agent session')
      const session = registry.get(owner, args.session_id)
      const chars = typeof args.chars === 'string' ? args.chars : ''
      const isPoll = chars.length === 0
      const yieldMs = clamp(
        args.yield_time_ms,
        isPoll ? MIN_EMPTY_YIELD_TIME_MS : MIN_WRITE_YIELD_TIME_MS,
        isPoll ? MAX_EMPTY_YIELD_TIME_MS : MAX_WRITE_YIELD_TIME_MS,
        isPoll ? MIN_EMPTY_YIELD_TIME_MS : MIN_WRITE_YIELD_TIME_MS
      )
      const start = Date.now()
      // max_output_tokens (codex schema parity): approximated by a character
      // budget, capped by the deployment-wide output cap.
      const maxChars = Math.min(
        clamp(args.max_output_tokens, 100, MAX_EMPTY_YIELD_TIME_MS * 10, DEFAULT_MAX_OUTPUT_CHARS),
        config.maxOutputChars
      )
      // The shell seam has no stdin pipe into a running background process
      // (win32 has no PTY here): Ctrl-C kills, other raw characters are
      // reported as not deliverable — the codex write_stdin approximation.
      if (!isPoll) {
        if (chars.includes('\u0003')) {
          if (!settled(session.proc)) await Promise.resolve(session.proc.kill()).catch(() => {})
          drainOutput(session)
          session.total += '\n[interrupt sent (Ctrl-C / SIGTERM equivalent)]\n'
        } else {
          session.total += `\n[stdin write not deliverable: the bash backend has no PTY on win32; ${JSON.stringify(chars)} was not sent]\n`
        }
      }
      const deadlineEnd = Date.now() + yieldMs
      while (!settled(session.proc)) {
        drainOutput(session)
        const status = await waitSettled(session.proc, deadlineEnd)
        if (status !== undefined) break
        if (Date.now() >= deadlineEnd) break
        if (exec.signal.aborted) exec.signal.throwIfAborted()
      }
      drainOutput(session)
      const wallTime = (Date.now() - start) / 1000
      const fresh = session.total.slice(session.delivered)
      session.delivered = session.total.length
      if (settled(session.proc)) {
        session.exitCode = session.proc.exitCode ?? null
        session.killed = session.proc.status === 'killed'
        registry.release(owner, args.session_id)
        const output = truncateOutput(fresh + killedNoteText(session), maxChars)
        return {
          exit_code: session.exitCode,
          wall_time_seconds: wallTime,
          output: output.text,
          truncated: output.truncated,
          original_token_count: Math.ceil(output.text.length / 4),
        }
      }
      const output = truncateOutput(fresh, maxChars)
      return {
        wall_time_seconds: wallTime,
        output: output.text,
        truncated: output.truncated,
        original_token_count: Math.ceil(output.text.length / 4),
      }
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

/** Final model-facing output text for a settled session. */
function finalOutput(session) {
  return session.total + killedNoteText(session)
}

/** Signal-death note appended to the final output of a killed process. */
function killedNoteText(session) {
  if (!session.killed) return ''
  return `\n[process terminated by signal${session.proc.signal !== null ? `: ${session.proc.signal}` : ''}]\n`
}

export const Config = z.object({
  maxOutputChars: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_CHARS),
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

/**
 * Apply the codex policy layer before execution: forbidden throws, prompt
 * goes through the DSH approval seam (the same seam the bash tool's sandbox
 * escalation uses), allowed-once proceeds. This is the codex `require_escalated`
 * path when the model passes `sandbox_permissions: require_escalated`.
 */
async function applyApprovalGate(ctx, owner, exec, args, config) {
  const argv = tokenize(args.cmd)
  const requestsEscalation = args.sandbox_permissions === 'require_escalated'
  const decision = classify(argv, {
    policy: effectiveCodexPolicy(ctx, owner, config),
    sandboxRestricted: sandboxRestricted(ctx),
    requestsEscalation,
    platform: process.platform,
  })
  if (decision.decision === DECISION.forbidden) {
    throw new Error(`command forbidden by approval policy: ${decision.reason}`)
  }
  if (decision.decision !== DECISION.prompt) return
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error('command requires approval but the approval service is unavailable')
  const reason = requestsEscalation
    ? (typeof args.justification === 'string' && args.justification.length > 0 ? args.justification : 'model requested escalation')
    : `command classified as ${decision.reason}`
  const outcome = await approval.request({
    agent: owner,
    toolName: 'exec_command',
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') throw new Error('command rejected by the user')
  throw new Error(`command approval unavailable (${outcome})`)
}

export function apply(ctx, config) {
  const resolved = {
    maxOutputChars: config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    policy: config.policy ?? 'on-request',
  }
  registerExecCommand(ctx, resolved)
}
