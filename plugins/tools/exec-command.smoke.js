/**
 * M1-R2 smoke test for dsh-codex/tools/exec-command.js — mock `ctx.shell`
 * (the host shell seam: resolve + start + background proc handles) with fake
 * processes that settle on timers, so the foreground-completion, yield +
 * write_stdin poll, control-byte, and registry-eviction paths
 * all run without a real shell.
 *
 * Semantics under test match codex HEAD 5bc8da6d78 (unified_exec):
 * - win32 exec_command yield floor 10000 ms (configurable via yieldFloorMs —
 *   the smoke pins it low to keep the suite fast),
 * - write_stdin \u0003 interrupts (signal death renders no exit-code
 *   section); any other non-empty chars throw the StdinClosed error,
 * - session ids random in 1000..100000; 64-process cap evicts LRU instead
 *   of failing,
 * - result text: Chunk ID → Wall time → Process exited → Process running →
 *   Original token count → Output: → body (context.rs:442-468).
 *
 * Usage: node tools/exec-command.smoke.js
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

const captured = []
const started = []
const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  get(service) {
    if (service === 'shellEnv') return { collect: () => ({ DSH_TEST: '1' }) }
    return undefined
  },
  shell: {
    resolve(request) {
      return { ...request, workdir: request.workdir ?? 'C:/work', timeoutMs: 30000, stdoutMaxBytes: 1 << 20 }
    },
    start(resolved) {
      started.push(resolved)
      return new FakeProc(resolved, scriptFor(resolved.command))
    },
  },
}

const { apply, approxTokens, truncateMiddle, formattedTruncateText, renderExecResult } = await import('./exec-command.js')
apply(ctx, { maxOutputBytes: 100000, yieldFloorMs: 250 })

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
assert.equal(typeof quick.chunk_id, 'string', 'chunk id generated per call')
assert.equal(typeof quick.original_token_count, 'number', 'original token count always present')
assert.equal(started[0].workdir, 'C:/work', 'session cwd forwarded as workdir')
assert.equal(started[0].dshEnv.DSH_TEST, '1', 'shell env collected')

// Render shape: Chunk ID → Wall time (4 decimals) → Process exited → Original token count → Output:
const rendered = renderExecResult(quick)
assert.ok(/^Chunk ID: [0-9a-f]{6}\n/.test(rendered), 'Chunk ID section first')
assert.ok(rendered.includes('Wall time: '), 'wall time section')
assert.ok(rendered.includes('Process exited with code 0'), 'exit-code section')
assert.ok(rendered.includes('Original token count: '), 'token-count section present even when not truncated (context.rs:460)')
assert.ok(rendered.endsWith('Output:\nhi\n'), 'Output: label then body')

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

// blank shell/workdir echoes are treated as omitted (echo-noise.js): models
// echo the optional string fields as "" — must run, never hard-fail
const blankEcho = await run(execCommand, { cmd: 'echo hi', shell: '', workdir: '   ' })
assert.equal(blankEcho.exit_code, 0, 'blank shell + whitespace workdir run normally')
assert.equal(started[started.length - 1].workdir, 'C:/work', 'blank workdir falls back to the session cwd')

const echoShape = await run(execCommand, {
  cmd: "pwd && rg --files -g 'AGENTS.md' -g '!node_modules' -g '!dist' -g '!build'",
  login: false,
  max_output_tokens: 2000,
  shell: 'bash',
  tty: false,
  workdir: process.cwd().replace(/\\/g, '/'),
  yield_time_ms: 10000,
})
assert.equal(echoShape.exit_code, 0, 'complete supported argument shape runs normally')
assert.equal(echoShape.output, 'hi\n', 'command actually executed through the shell seam')
assert.equal(started[started.length - 1].workdir, process.cwd(), 'forward-slash absolute workdir canonicalized to backslashes')

// ── workdir normalization (Windows host shell) ──────────────────────────────
// The cc-switch GPT wire emits MSYS/git-bash paths ("/d/..."); passed through
// verbatim they make spawn fail with a misleading `spawn bash ENOENT` (Windows
// surfaces an invalid cwd as ENOENT). They must normalize to Windows paths.
if (process.platform === 'win32') {
  const real = process.cwd()
  const msys = '/' + real[0].toLowerCase() + real.slice(2).replace(/\\/g, '/')
  const msysRun = await run(execCommand, { cmd: 'echo hi', workdir: msys })
  assert.equal(msysRun.exit_code, 0, 'MSYS /d/... workdir normalized and runs')
  assert.equal(started[started.length - 1].workdir, real, 'MSYS workdir normalized to the Windows absolute path')
}

const missingPosix = await run(execCommand, { cmd: 'echo hi', workdir: '/d/Data/DEV/does-not-exist-xyz' }).catch((error) => error)
assert.ok(missingPosix instanceof Error && /workdir is not an existing directory/.test(missingPosix.message), 'nonexistent workdir rejected with a clear message')
assert.ok(/resolved to [A-Z]:/.test(missingPosix.message), 'clear error mentions the resolved Windows path')

const missingWin = await run(execCommand, { cmd: 'echo hi', workdir: 'D:\\Data\\DEV\\does-not-exist-xyz' }).catch((error) => error)
assert.ok(missingWin instanceof Error && /workdir is not an existing directory/.test(missingWin.message), 'nonexistent Windows workdir also rejected clearly')

// POSIX shell aliases are accepted (the cc-switch wire echoes them; this
// deployment has exactly one shell backend).
const posixShell = await run(execCommand, { cmd: 'echo hi', shell: '/bin/sh' })
assert.equal(posixShell.exit_code, 0, 'POSIX shell alias /bin/sh accepted and maps to the git-bash backend')

// ── yield → session id → write_stdin poll ──────────────────────────────────
const slow = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
assert.equal(typeof slow.session_id, 'number', 'yielded session id')
assert.ok(slow.session_id >= 1000 && slow.session_id < 100000, 'session id in the official 1000..100000 range')
assert.equal(slow.output, '', 'no output yet at yield')
const polled = await run(writeStdin, { session_id: slow.session_id, chars: '', yield_time_ms: 500 })
assert.ok(polled.session_id === undefined, 'still-running poll returns no exit code')
assert.ok(polled.output === '', 'no new output in the poll')

// ── delta semantics: only NEW output after the first read ──────────────────
const trickle = await run(execCommand, { cmd: 'trickle', yield_time_ms: 250 })
assert.equal(typeof trickle.session_id, 'number', 'trickle yielded')
assert.ok(trickle.output.includes('one'), 'first chunk delivered at yield')
assert.ok(!trickle.output.includes('two'), 'second chunk not yet delivered')
const poll2 = await run(writeStdin, { session_id: trickle.session_id, chars: '', yield_time_ms: 5000 })
assert.equal(poll2.exit_code, 0, 'trickle completed on poll')
assert.ok(poll2.output.includes('two') && !poll2.output.includes('one'), 'poll returns only the new chunk')

// ── control bytes: \u0003 interrupts (signal death → no exit-code section);
// any other chars are the official StdinClosed error ───────────────────────
const runaway = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
const ctrlc = await run(writeStdin, { session_id: runaway.session_id, chars: '\u0003', yield_time_ms: 2000 })
assert.equal(ctrlc.exit_code, undefined, 'Ctrl-C kills: exit code omitted (Option<i32> None)')
assert.ok(!ctrlc.output.includes('[interrupt'), 'no synthetic interrupt notice (codex emits none)')
assert.ok(!renderExecResult(ctrlc).includes('Process exited'), 'signal death renders no exit-code section')

const runaway2 = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
const stray = await run(writeStdin, { session_id: runaway2.session_id, chars: 'hello', yield_time_ms: 250 }).catch((error) => error)
assert.ok(stray instanceof Error, 'non-control stdin rejected')
assert.ok(stray.message === 'write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open', 'StdinClosed error message verbatim (errors.rs)')
const aliveAfterStray = await run(writeStdin, { session_id: runaway2.session_id, chars: '', yield_time_ms: 500 })
assert.ok(aliveAfterStray.session_id === undefined || aliveAfterStray.exit_code === null, 'stray write did not kill the session')
await run(writeStdin, { session_id: runaway2.session_id, chars: '\u0003', yield_time_ms: 2000 })

const unknown = await run(writeStdin, { session_id: 9999, chars: '' }).catch((error) => error)
assert.ok(unknown instanceof Error && /Unknown process id 9999/.test(unknown.message), 'unknown session uses the official message')

// ── registry cap: 64 processes → LRU eviction (never an error) ─────────────
const ids = []
for (let i = 0; i < 65; i++) {
  const result = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
  assert.equal(typeof result.session_id, 'number', 'session ' + i + ' allocated')
  ids.push(result.session_id)
}
assert.equal(new Set(ids).size, 65, '65 sessions allocated')
const evicted = await run(writeStdin, { session_id: ids[0], chars: '' }).catch((error) => error)
assert.ok(evicted instanceof Error && /Unknown process id/.test(evicted.message), 'oldest session evicted at the cap')
// the most recent sessions survive
const newestAlive = await run(writeStdin, { session_id: ids[64], chars: '\u0003', yield_time_ms: 1000 })
assert.equal(newestAlive.exit_code, undefined, 'newest session survives the cap (signal death omits exit code)')

// ── truncation helpers (official string/truncate.rs + output-truncation) ────
assert.equal(approxTokens('hello'), 2, 'approx tokens = ceil(bytes/4)')
assert.equal(approxTokens(''), 0, 'empty text → 0 tokens')
const mid = truncateMiddle('0123456789', 4, true)
assert.ok(mid.startsWith('01') && mid.endsWith('89'), 'head and tail preserved')
assert.ok(/…\d+ tokens truncated…/.test(mid), 'token-truncation marker present')
const ft = formattedTruncateText('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 2)
assert.ok(ft.startsWith('Warning: truncated output (original token count: 5)\nTotal output lines: 10\n\n'), 'formatted truncation prefix: tokens=ceil(19/4)=5, lines=10')

// ── schema compatibility spot checks ───────────────────────────────────────
const params = execCommand.parameters.properties ?? {}
for (const key of ['cmd', 'workdir', 'tty', 'yield_time_ms', 'max_output_tokens', 'shell', 'login'])
  assert.ok(params[key] !== undefined, 'exec_command has ' + key)
assert.ok((execCommand.parameters.required ?? []).includes('cmd'), 'cmd required')
for (const key of ['sandbox_permissions', 'justification', 'prefix_rule', 'description'])
  assert.equal(params[key], undefined, 'compatibility field stays out of the wire schema: ' + key)
assert.equal(execCommand.description, 'Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\nWindows safety rules:\n- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.\n- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.\n- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.', 'exec_command description verbatim (win32)')
assert.equal(writeStdin.description, 'Writes characters to an existing unified exec session and returns recent output.', 'write_stdin description verbatim')
const stdinParams = writeStdin.parameters.properties ?? {}
assert.ok((writeStdin.parameters.required ?? []).includes('session_id'), 'write_stdin session_id required')
assert.equal(stdinParams.chars.description, 'Bytes to write to stdin. Defaults to empty, which polls without writing.', 'chars description verbatim')
assert.equal(stdinParams.yield_time_ms.description, 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.', 'yield_time_ms description verbatim')

// The parameter root is intentionally open, so provider compatibility
// metadata is accepted without advertising empty schemas on the wire.
for (const metadata of [
  { justification: '', description: 'why', sandbox_permissions: null, prefix_rule: { mode: 'read-only' } },
  { justification: { reason: 'compatibility echo' }, description: ['free-form'], sandbox_permissions: false, prefix_rule: 7 },
]) {
  const metadataRun = await run(execCommand, { cmd: 'echo hi', ...metadata })
  assert.equal(metadataRun.exit_code, 0, 'compatibility metadata does not block execution')
}

// output schema = official unified_exec_output_schema
const outProps = execCommand.output.schema.properties
for (const key of ['chunk_id', 'wall_time_seconds', 'exit_code', 'session_id', 'original_token_count', 'output'])
  assert.ok(outProps[key] !== undefined, 'output schema has ' + key)
assert.ok((execCommand.output.schema.required ?? []).includes('wall_time_seconds'), 'wall_time_seconds required')
assert.ok((execCommand.output.schema.required ?? []).includes('output'), 'output required')

console.log('exec-command smoke test: ALL PASS')
