/**
 * M1-R2 smoke test for dsh-codex/tools/exec-command.js — mock `ctx.shell`
 * (the host shell seam: resolve + start + background proc handles) with fake
 * processes that settle on timers, so the foreground-completion, yield +
 * write_stdin poll, control-byte, registry-cap, and approval-gate paths all
 * run without a real shell.
 *
 * Usage: node dsh-codex/tools/exec-command.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

/** Fake background process handle matching the ctx.shell.start contract. */
class FakeProc {
  constructor(spec, script) {
    this.spec = spec
    this.status = 'running'
    this.exitCode = null
    this.signal = null
    this.buffer = ''
    this.doneResolve = null
    this.done = new Promise((resolve) => (this.doneResolve = resolve))
    const steps = script.steps
    const settleAt = script.settleAt
    for (const [at, text] of steps) setTimeout(() => (this.buffer += text), at)
    if (settleAt !== null) {
      setTimeout(() => {
        if (script.killed) {
          this.status = 'killed'
          this.signal = 'SIGTERM'
        } else {
          // Real dsh-bash-local contract: a normally finished background
          // process reports status `completed` (domain: running|completed|killed).
          this.status = 'completed'
          this.exitCode = script.exitCode ?? 0
        }
        this.doneResolve()
      }, settleAt)
    }
  }
  readOutput() {
    const delta = this.buffer
    this.buffer = ''
    return { delta, lossy: false }
  }
  kill() {
    if (this.status !== 'running') return Promise.resolve()
    this.status = 'killed'
    this.signal = 'SIGTERM'
    this.doneResolve()
    return Promise.resolve()
  }
}

/** Route a fake shell command to a script. */
function scriptFor(command) {
  if (command.includes('trickle')) return { steps: [[60, 'one\n'], [600, 'two\n']], settleAt: 600 }
  if (command.includes('never')) return { steps: [], settleAt: null }
  if (command.includes('crash')) return { steps: [], settleAt: 20, exitCode: 2 }
  if (command.includes('killme')) return { steps: [[10, 'dying\n']], settleAt: 50, killed: true }
  if (command.includes('sleep 0.3')) return { steps: [[400, 'done\n']], settleAt: 400 }
  return { steps: [[0, 'hi\n']], settleAt: 0 }
}

const started = []
let sandboxMode = 'danger-full-access'
const approvalLog = []
let approvalOutcome = 'allowed-once'
let sessionOverride
const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  get(service) {
    if (service === 'approval')
      return {
        config: { policy: 'ask' },
        overrideOf() {
          return sessionOverride
        },
        async request(req) {
          approvalLog.push(req)
          return approvalOutcome
        },
      }
    if (service === 'fs') return { sandboxMode }
    if (service === 'shellEnv') return { collect: () => ({ DSH_TEST: '1' }) }
    return undefined
  },
  shell: {
    sandboxMode,
    resolve(request) {
      return { ...request, workdir: request.workdir ?? 'C:/work', timeoutMs: 30000, stdoutMaxBytes: 1 << 20 }
    },
    start(resolved) {
      started.push(resolved)
      return new FakeProc(resolved, scriptFor(resolved.command))
    },
  },
}

const captured = []
const { apply } = await import('./exec-command.js')
apply(ctx, { maxOutputChars: 100000 })

const execCommand = captured.find((t) => t.name === 'exec_command')
const writeStdin = captured.find((t) => t.name === 'write_stdin')
assert.ok(execCommand, 'exec_command registered')
assert.ok(writeStdin, 'write_stdin registered')

const owner = { session: { header: { cwd: 'C:/work' } }, ctx: { effect: () => () => {} } }
const run = (definition, args) => definition.execute(args, { agent: owner, signal: new AbortController().signal, callId: 'call-1' })

// ── foreground completion ──────────────────────────────────────────────────
const quick = await run(execCommand, { cmd: 'echo hi' })
assert.equal(quick.exit_code, 0, 'exit code captured (host seam reports `completed`)')
assert.ok(quick.output.includes('hi'), 'output captured')
assert.ok(quick.session_id === undefined, 'no session id when completed')
assert.equal(started[0].workdir, 'C:/work', 'session cwd forwarded as workdir')
assert.equal(started[0].dshEnv.DSH_TEST, '1', 'shell env collected')

// Regression (2026-08-15): the real dsh-bash-local handle settles as
// `completed`, which settled() must accept — otherwise a finished command is
// misreported as "Process running with session ID N" and every exec_command
// is followed by a payload-less write_stdin poll.
const quick2 = await run(execCommand, { cmd: 'echo hi', yield_time_ms: 250 })
assert.equal(quick2.exit_code, 0, 'completed within yield returns exit code')
assert.ok(quick2.session_id === undefined, 'completed within yield registers no session')

const crashed = await run(execCommand, { cmd: 'crash' })
assert.equal(crashed.exit_code, 2, 'nonzero exit code captured')

// ── shell parameter validation (git bash only) ─────────────────────────────
const badShell = await run(execCommand, { cmd: 'echo hi', shell: 'powershell' }).catch((error) => error)
assert.ok(badShell instanceof Error && /unsupported shell "powershell"/.test(badShell.message), 'unknown shell rejected')
const goodShell = await run(execCommand, { cmd: 'echo hi', shell: 'git-bash' })
assert.equal(goodShell.exit_code, 0, 'bash/shell/git-bash accepted and map to the git-bash backend')

// ── yield → session id → write_stdin poll ──────────────────────────────────
const slow = await run(execCommand, { cmd: 'sleep 0.3 && echo done', yield_time_ms: 250 })
assert.equal(typeof slow.session_id, 'number', 'yielded session id')
assert.equal(slow.output, '', 'no output yet at yield')
const polled = await run(writeStdin, { session_id: slow.session_id, chars: '', yield_time_ms: 5000 })
assert.equal(polled.exit_code, 0, 'write_stdin poll observes completion')
assert.ok(polled.output.includes('done'), 'poll returns new output')

// ── delta semantics: only NEW output after the first read ──────────────────
const trickle = await run(execCommand, { cmd: 'trickle', yield_time_ms: 250 })
assert.equal(typeof trickle.session_id, 'number', 'trickle yielded')
assert.ok(trickle.output.includes('one'), 'first chunk delivered at yield')
assert.ok(!trickle.output.includes('two'), 'second chunk not yet delivered')
const poll2 = await run(writeStdin, { session_id: trickle.session_id, chars: '', yield_time_ms: 5000 })
assert.equal(poll2.exit_code, 0, 'trickle completed on poll')
assert.ok(poll2.output.includes('two') && !poll2.output.includes('one'), 'poll returns only the new chunk')

// ── control bytes: Ctrl-C kills, other chars are not deliverable ───────────
const runaway = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
assert.equal(typeof runaway.session_id, 'number', 'never-settling session yielded')
const ctrlc = await run(writeStdin, { session_id: runaway.session_id, chars: '\u0003', yield_time_ms: 2000 })
assert.equal(ctrlc.exit_code, null, 'Ctrl-C kills: exit code null')
assert.ok(ctrlc.output.includes('[interrupt sent'), 'interrupt notice delivered')

const runaway2 = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
const stray = await run(writeStdin, { session_id: runaway2.session_id, chars: 'hello', yield_time_ms: 250 })
assert.ok(stray.output.includes('not deliverable'), 'non-control stdin reported not deliverable (no PTY on win32)')
const killedNote = await run(writeStdin, { session_id: runaway2.session_id, chars: '\u0003', yield_time_ms: 2000 })
assert.ok(killedNote.output.includes('[process terminated by signal: SIGTERM]'), 'killed note in final output')

const unknown = await run(writeStdin, { session_id: 9999, chars: '' }).catch((error) => error)
assert.ok(unknown instanceof Error && /unknown exec session/.test(unknown.message), 'unknown session rejected')

// ── registry cap ───────────────────────────────────────────────────────────
const registry = await (async () => {
  const ids = []
  for (let i = 0; i < 65; i++) {
    const result = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
    ids.push(result.session_id)
  }
  return ids
})().catch((error) => error)
assert.ok(registry instanceof Error, 'registry cap enforced at 64 sessions')

// ── approval gate ───────────────────────────────────────────────────────────
assert.equal(approvalLog.length, 0, 'safe command (echo) ran without approval')

const dangerous = await run(execCommand, { cmd: 'rm -rf build' })
assert.equal(dangerous.exit_code, 0, 'dangerous command runs after approval')
assert.equal(approvalLog.length, 1, 'dangerous command asked once')
assert.equal(approvalLog[0].toolName, 'exec_command')
assert.ok(approvalLog[0].reason.includes('dangerous'), 'approval reason carries classification')

approvalOutcome = 'rejected'
await assert.rejects(
  () => run(execCommand, { cmd: 'rm -rf build' }),
  /command rejected by the user/,
  'rejected approval blocks the command'
)
approvalOutcome = 'allowed-once'

sessionOverride = 'never'
const beforeNever = approvalLog.length
await assert.rejects(
  () => run(execCommand, { cmd: 'rm -rf build' }),
  /command forbidden by approval policy: dangerous/,
  'never policy forbids dangerous commands without prompting'
)
assert.equal(approvalLog.length, beforeNever, 'never policy does not ask')
sessionOverride = undefined

// explicit escalation: under an unrestricted sandbox codex SKIPS approval
// (default_exec_approval_requirement), so require_escalated only prompts under
// a restricted sandbox — switch the fs mock to workspace-write to exercise it.
const beforeEscalation = approvalLog.length
await run(execCommand, { cmd: 'curl http://x', sandbox_permissions: 'require_escalated', justification: 'needs network' })
assert.equal(approvalLog.length, beforeEscalation, 'unrestricted sandbox skips escalation prompts (codex Skip)')

sandboxMode = 'workspace-write'
await run(execCommand, { cmd: 'curl http://x', sandbox_permissions: 'require_escalated', justification: 'needs network' })
assert.equal(approvalLog[approvalLog.length - 1].reason, 'needs network', 'escalation justification reaches the UI under a restricted sandbox')
sandboxMode = 'danger-full-access'

// ── schema parity spot checks ──────────────────────────────────────────────
const params = execCommand.parameters.properties ?? {}
for (const key of ['cmd', 'workdir', 'yield_time_ms', 'max_output_tokens', 'sandbox_permissions', 'justification', 'prefix_rule'])
  assert.ok(params[key] !== undefined, `exec_command has ${key}`)
const stdinParams = writeStdin.parameters.properties ?? {}
assert.ok((writeStdin.parameters.required ?? []).includes('session_id'), 'write_stdin session_id required')

console.log('exec-command smoke test: ALL PASS')
