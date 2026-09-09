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
 *   Original token count → Output: → body (context.rs response_text as of
 *   rust-v0.153.4, including header budget).
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
const jobRuns = []
let jobsService = { start(spec) {
  const handle = spec.run()
  jobRuns.push(handle)
  return `exec-${jobRuns.length}`
} }
const started = []
const files = new Map()
const dirs = new Set(['C:/work'])
function normJoin(base, p) {
  const isAbs = /^[A-Za-z]:/.test(p) || p.startsWith('/')
  const raw = isAbs ? p : `${base}/${p}`
  const parts = []
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}
const mockFs = {
  async resolve(path, opts = {}) {
    const abs = normJoin(opts.cwd ?? 'C:/work', path)
    return { targetKey: abs, displayPath: abs }
  },
  async lstat(path, opts = {}) {
    const abs = normJoin(opts.cwd ?? 'C:/work', path)
    if (files.has(abs)) return { version: 'v1', type: 'file', size: files.get(abs).length }
    if (dirs.has(abs)) return { version: 'v1', type: 'directory', size: 0 }
    return undefined
  },
  async stat(target) {
    if (files.has(target.targetKey)) return { version: 'v1', type: 'file', size: files.get(target.targetKey).length }
    if (dirs.has(target.targetKey)) return { version: 'v1', type: 'directory', size: 0 }
    return undefined
  },
  async readText(target) {
    if (!files.has(target.targetKey)) {
      const error = new Error(`file not found: ${target.displayPath}`)
      error.code = 'ENOENT'
      throw error
    }
    return files.get(target.targetKey)
  },
  async writeText(target, content) {
    files.set(target.targetKey, content)
    const parts = target.targetKey.replace(/\\/g, '/').split('/')
    parts.pop()
    const parent = parts.join('/')
    if (parent.length > 0) dirs.add(parent)
    return { operation: 'update', version: 'v2', before: null, after: content }
  },
  async mkdir(target) {
    const raw = target.targetKey.replace(/\\/g, '/')
    const parts = []
    for (const seg of raw.split('/')) {
      if (seg === '' || seg === '.') continue
      parts.push(seg)
      dirs.add(parts.join('/'))
    }
  },
  processPath(target) {
    return target.targetKey
  },
  contains(parent, child) {
    const p = parent.targetKey.replace(/\/+$/, '')
    return child.targetKey === p || child.targetKey.startsWith(`${p}/`)
  },
}
const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  fs: mockFs,
  get(service) {
    if (service === 'jobs') return jobsService
    if (service === 'shellEnv') return { collect: () => ({ DSH_TEST: '1' }) }
    return undefined
  },
  shell: {
    resolve(request) {
      return { ...request, workdir: request.workdir ?? 'C:/work', timeoutMs: 30000, stdoutMaxBytes: 1 << 20 }
    },
    start(resolved) {
      started.push(resolved)
      if (resolved.command.includes('explode-long')) {
        throw new Error(`boom ${'x'.repeat(2000)}`)
      }
      if (resolved.command.includes('explode-short')) {
        throw new Error('nope')
      }
      return new FakeProc(resolved, scriptFor(resolved.command))
    },
  },
}

const { apply, approxTokens, truncateMiddle, formattedTruncateText, renderExecResult, truncatedOutputBody, formatExecCommandFailure, parseEmbeddedApplyPatch, SHELL_VALUES } = await import('./exec-command.js')
apply(ctx, { maxOutputBytes: 100000, yieldFloorMs: 250 })

const execCommand = captured.find((t) => t.name === 'exec_command')
const writeStdin = captured.find((t) => t.name === 'write_stdin')
assert.ok(execCommand, 'exec_command registered')
assert.ok(writeStdin, 'write_stdin registered')

const owner = { session: { header: { cwd: 'C:/work' } }, ctx: { effect: () => () => {} } }
const run = (definition, args) => definition.execute(args, { agent: owner, signal: new AbortController().signal, callId: 'call-1' })

// Job-backed foreground commands must never emit redundant completion notices.
const fastJob = await run(execCommand, { cmd: 'echo hi', yield_time_ms: 250 })
assert.equal(fastJob.exit_code, 0)
const failedJob = await run(execCommand, { cmd: 'crash', yield_time_ms: 250 })
assert.equal(failedJob.exit_code, 2)
assert.equal(jobRuns.length, 0, 'foreground success and failure never register jobs')
const deferredJob = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
assert.equal(jobRuns.length, 1, 'only a yielded process becomes a job')
assert.equal(deferredJob.session_id, deferredJob.job_id, 'one shared identifier')
jobRuns[0].cancel()
assert.equal((await jobRuns[0].done).status, 'killed', 'job cancellation owns existing process')
const startJob = jobsService.start
jobsService.start = () => { throw new Error('job limit') }
await assert.rejects(run(execCommand, { cmd: 'never', yield_time_ms: 250 }), /job limit/)
jobsService.start = startJob

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
assert.ok(!missingPosix.message.startsWith('exec_command failed:'), 'workdir preflight stays unwrapped so the model sees the original fix')

const missingWin = await run(execCommand, { cmd: 'echo hi', workdir: 'D:\\Data\\DEV\\does-not-exist-xyz' }).catch((error) => error)
assert.ok(missingWin instanceof Error && /workdir is not an existing directory/.test(missingWin.message), 'nonexistent Windows workdir also rejected clearly')

// POSIX shell aliases are accepted (the cc-switch wire echoes them; this
// deployment has exactly one shell backend).
const posixShell = await run(execCommand, { cmd: 'echo hi', shell: '/bin/sh' })
assert.equal(posixShell.exit_code, 0, 'POSIX shell alias /bin/sh accepted and maps to the git-bash backend')

// ── yield → session id → write_stdin poll ──────────────────────────────────
const slow = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
assert.equal(typeof slow.session_id, 'string', 'yielded session id')
assert.ok(slow.session_id.length > 0, 'session id is non-empty')
assert.equal(slow.output, '', 'no output yet at yield')
const polled = await run(writeStdin, { session_id: slow.session_id, chars: '', yield_time_ms: 500 })
assert.ok(polled.session_id === undefined, 'still-running poll returns no exit code')
assert.ok(polled.output === '', 'no new output in the poll')

// ── delta semantics: only NEW output after the first read ──────────────────
const trickle = await run(execCommand, { cmd: 'trickle', yield_time_ms: 250 })
assert.equal(typeof trickle.session_id, 'string', 'trickle yielded')
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

const unknown = await run(writeStdin, { session_id: "exec-session-9999", chars: '' }).catch((error) => error)
assert.ok(unknown instanceof Error && /Unknown process id exec-session-9999/.test(unknown.message), 'unknown session uses the official message')

// ── registry cap: 64 processes → LRU eviction (never an error) ─────────────
const ids = []
for (let i = 0; i < 65; i++) {
  const result = await run(execCommand, { cmd: 'never', yield_time_ms: 250 })
  assert.equal(typeof result.session_id, 'string', 'session ' + i + ' allocated')
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
assert.ok(execCommand.description.includes('Long-running commands are also registered as DSH background jobs.'), 'exec_command documents DSH jobs')
assert.ok(execCommand.description.includes('job_output'), 'exec_command documents job waiting')
assert.ok(!/powershell|cmd\.exe|Start-Process|Remove-Item/i.test(execCommand.description), 'no PowerShell-only vocabulary in the description')
assert.ok(params.shell.description.includes('only provides git bash'), 'shell param names git bash as the only shell')
for (const value of SHELL_VALUES) assert.ok(params.shell.description.includes(value), 'shell param lists accepted value: ' + value)
assert.ok(!/powershell|PowerShell/i.test(params.shell.description), 'shell param description has no PowerShell wording')
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

assert.equal(parseEmbeddedApplyPatch('echo hi').kind, 'none', 'ordinary commands are not intercepted')
assert.equal(parseEmbeddedApplyPatch('apply_patch --help').kind, 'none', 'apply_patch --help is not a patch body')
assert.equal(parseEmbeddedApplyPatch("apply_patch '--help'").kind, 'none', 'quoted --help is not a patch body')
assert.equal(parseEmbeddedApplyPatch('apply_patch').kind, 'none', 'bare apply_patch is not intercepted')
assert.equal(
  parseEmbeddedApplyPatch('echo before && apply_patch <<EOF\n*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch\nEOF').kind,
  'none',
  'leading commands prevent intercept'
)

// ── intercept: heredoc apply_patch never reaches the shell ─────────────────
const startedBeforeIntercept = started.length
const heredocCmd = [
  "apply_patch <<'EOF'",
  '*** Begin Patch',
  '*** Add File: intercepted.txt',
  '+hello',
  '*** End Patch',
  'EOF',
].join('\n')
const intercepted = await run(execCommand, { cmd: heredocCmd })
assert.equal(started.length, startedBeforeIntercept, 'heredoc apply_patch must not start a shell process')
assert.ok(intercepted.output.includes('A intercepted.txt'), 'intercepted heredoc applies the patch')
assert.equal(files.get('C:/work/intercepted.txt'), 'hello\n', 'intercepted heredoc wrote the file')
assert.equal(intercepted.session_id, undefined, 'intercepted apply_patch is not a resumable session')
assert.equal(intercepted.exit_code, undefined, 'intercepted apply_patch omits exec exit_code (codex process_id/exit_code None)')

const aliasCmd = [
  'applypatch <<EOF',
  '*** Begin Patch',
  '*** Add File: alias.txt',
  '+alias',
  '*** End Patch',
  'EOF',
].join('\n')
await run(execCommand, { cmd: aliasCmd })
assert.equal(files.get('C:/work/alias.txt'), 'alias\n', 'applypatch alias is intercepted')

const quotedBody = await run(execCommand, {
  cmd: "apply_patch '*** Begin Patch\n*** Add File: quoted.txt\n+quoted\n*** End Patch'",
})
assert.equal(files.get('C:/work/quoted.txt'), 'quoted\n', 'quoted apply_patch body is intercepted')
assert.equal(started.length, startedBeforeIntercept, 'quoted apply_patch must not start a shell process')

dirs.add('C:/work/sub')
const cdHeredoc = [
  "cd sub && apply_patch <<'EOF'",
  '*** Begin Patch',
  '*** Add File: nested.txt',
  '+nested',
  '*** End Patch',
  'EOF',
].join('\n')
await run(execCommand, { cmd: cdHeredoc })
assert.equal(files.get('C:/work/sub/nested.txt'), 'nested\n', 'cd && apply_patch heredoc uses the cd path as cwd')

const extra = await run(execCommand, {
  cmd: [
    "apply_patch <<'EOF'",
    '*** Begin Patch',
    '*** Add File: extra.txt',
    '+nope',
    '*** End Patch',
    'EOF',
    '&& echo done',
  ].join('\n'),
})
assert.equal(started.length, startedBeforeIntercept + 1, 'trailing commands prevent intercept and run in the shell')
assert.equal(files.has('C:/work/extra.txt'), false, 'non-intercepted heredoc with extra commands does not apply')
assert.ok(extra.output.includes('hi'), 'non-intercepted command still runs through the fake shell')

const helpQuoted = await run(execCommand, { cmd: "apply_patch --help" })
assert.equal(started.length, startedBeforeIntercept + 2, 'apply_patch --help is not an intercepted patch body')
assert.equal(helpQuoted.output, 'hi\n', 'non-patch apply_patch argv still runs in the shell')

const quotedHelp = await run(execCommand, { cmd: "apply_patch '--help'" })
assert.equal(started.length, startedBeforeIntercept + 3, 'quoted non-patch apply_patch argv still reaches the shell')
assert.equal(quotedHelp.output, 'hi\n', 'quoted --help is not treated as a patch')

const prefixed = await run(execCommand, {
  cmd: "echo before && apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: prefixed.txt\n+x\n*** End Patch\nEOF",
})
assert.equal(started.length, startedBeforeIntercept + 4, 'leading commands prevent intercept')
assert.equal(files.has('C:/work/prefixed.txt'), false, 'prefixed heredoc does not apply')
assert.equal(prefixed.output, 'hi\n', 'prefixed command still runs in the shell')

const implicit = await run(execCommand, {
  cmd: '*** Begin Patch\n*** Add File: implicit.txt\n+x\n*** End Patch',
}).catch((error) => error)
assert.ok(implicit instanceof Error, 'raw patch body is not silently applied')
assert.equal(
  implicit.message,
  'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]',
  'implicit invocation uses the official message'
)
assert.equal(files.has('C:/work/implicit.txt'), false, 'implicit patch does not write')
assert.equal(started.length, startedBeforeIntercept + 4, 'implicit patch does not start a shell')

// ── exec_command failure: prefix + 900-byte middle truncation, no cmd echo ─
const shortFail = await run(execCommand, { cmd: 'explode-short' }).catch((error) => error)
assert.ok(shortFail instanceof Error, 'short spawn failure is an error')
assert.equal(shortFail.message, 'exec_command failed: nope', 'short failure uses the official prefix and omits the cmd')
assert.ok(!shortFail.message.includes('explode-short'), 'failure message does not echo cmd')

const longFail = await run(execCommand, { cmd: 'explode-long' }).catch((error) => error)
assert.ok(longFail instanceof Error, 'long spawn failure is an error')
assert.ok(longFail.message.startsWith('exec_command failed: '), 'long failure keeps the official prefix')
assert.ok(/…\d+ chars truncated…/.test(longFail.message), 'long failure is middle-truncated with a char marker')
assert.ok(!longFail.message.includes('explode-long'), 'truncated failure does not echo cmd')
assert.equal(
  formatExecCommandFailure(new Error('nope')),
  'exec_command failed: nope',
  'formatExecCommandFailure is a no-op under the 900-byte budget'
)

// ── response_text header budget: shrink body so header+body fit 1.2× policy ─
const headerBudgetBody = `${'abcdefghij\n'.repeat(40)}`
const headerBudgetValue = {
  chunk_id: '00ff00',
  exit_code: 0,
  wall_time_seconds: 1.25,
  output: headerBudgetBody,
  truncated: true,
  original_token_count: 110,
  model_output_max_tokens: 80,
  serialization_max_tokens: 50,
}
const headerBudgetText = renderExecResult(headerBudgetValue)
const header = headerBudgetText.slice(0, headerBudgetText.indexOf('\nOutput:') + '\nOutput:'.length)
const body = headerBudgetText.slice(header.length + 1)
const serializationBudget = Math.ceil(50 * 1.2) * 4
assert.ok(Buffer.byteLength(body, 'utf8') <= serializationBudget - Buffer.byteLength(header, 'utf8') - 1, 'body reserved room for the header under 1.2× serialization policy')
assert.ok(body.includes('tokens truncated') || body.includes('Warning: truncated output'), 'header-budget shrink still reports truncation')
assert.ok(
  Buffer.byteLength(truncatedOutputBody(headerBudgetValue), 'utf8') > Buffer.byteLength(body, 'utf8'),
  'header budget shrinks a body that already fit the model token cap',
)

console.log('exec-command smoke test: ALL PASS')
