/** Real DSH shell + subprocess + jobs; no model/network or installed-file edits. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service, resolveConfig } from '@deepseek-ai/cordis'
import LocalBash from '@deepseek-ai/dsh-bash-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as jobTools from '@deepseek-ai/dsh-tool-jobs'
import { apply } from './exec-command.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-shell-integration-'))
const ctx = new Context(), definitions = new Map(), specs = [], processes = []
const owner = { id: 'exec-integration', session: { id: 'exec-integration', header: { cwd: root } }, ctx,
  status: 'running', inject() {} }
class Agents extends Service { constructor(context) { super(context, 'agents') } get(id) { return id === owner.id ? owner : undefined } }
try {
  new Agents(ctx)
  new LocalSubprocess(ctx)
  new LocalJobs(ctx, resolveConfig(LocalJobs, { pumpPollMs: 10 }))
  new SystemPrompt(ctx, resolveConfig(SystemPrompt, {}))
  const bash = new LocalBash(ctx, resolveConfig(LocalBash, { cwd: root, timeoutMs: 50, maxTimeoutMs: 30000 }))
  const modern = typeof bash.execute === 'function'
  const shell = { resolve(request) { const spec = bash.resolve(request); specs.push(spec); return spec } }
  if (modern) shell.execute = async spec => { const proc = await bash.execute(spec); processes.push(proc); return proc }
  else shell.start = spec => { const proc = bash.start(spec); processes.push(proc); return proc }
  const facade = { tools: { register: tool => definitions.set(tool.name, tool) }, shell, fs: {}, jobs: ctx.jobs,
    systemPrompt: ctx.systemPrompt, get: name => ctx.get(name), on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx) }
  jobTools.apply(facade, { completionDelivery: 'quiet' })
  apply(facade, { yieldFloorMs: 10 })
  const run = (name, args, signal = new AbortController().signal) => definitions.get(name).execute(args, { agent: owner, signal, callId: name })
  const short = await run('exec_command', { cmd: "printf 'short-output\\n'", yield_time_ms: 3000 })
  assert.equal(short.exit_code, 0); assert.match(short.output, /short-output/); assert.equal(short.session_id, undefined)
  const failed = await run('exec_command', { cmd: "printf 'failure-output\\n' >&2; exit 7", yield_time_ms: 3000 })
  assert.equal(failed.exit_code, 7); assert.match(failed.output, /failure-output/)
  const lifetime = new AbortController()
  const long = await run('exec_command', { cmd: "printf 'before-yield\\n'; sleep 0.7; printf 'after-yield\\n'", yield_time_ms: 10 }, lifetime.signal)
  assert.ok(long.session_id); assert.equal(long.session_id, long.job_id)
  lifetime.abort(new Error('tool invocation ended after promotion'))
  const polled = await run('write_stdin', { session_id: long.session_id, yield_time_ms: 5000 })
  assert.equal(polled.exit_code, 0); assert.match(polled.output, /after-yield/)
  const job = await run('job_output', { job_id: long.job_id, wait: true, timeout_ms: 5000 })
  assert.match(job.text, /after-yield/, 'native job output must retain bytes already read by write_stdin')
  const waiting = await run('exec_command', { cmd: 'sleep 20', yield_time_ms: 10 })
  await run('job_kill', { job_id: waiting.job_id })
  await processes.at(-1).done
  assert.equal(processes.at(-1).status, 'killed')
  if (modern) {
    const originalExecute = shell.execute
    const preparing = new AbortController()
    const started = processes.length
    shell.execute = spec => bash.executeArgv(spec, signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      signal.throwIfAborted()
    }))
    const pending = run('exec_command', { cmd: 'must-not-spawn', yield_time_ms: 3000 }, preparing.signal)
    const timer = setTimeout(() => preparing.abort(new Error('native preparation cancelled')), 50)
    await assert.rejects(pending, /native preparation cancelled/)
    clearTimeout(timer)
    assert.equal(processes.length, started)
    shell.execute = originalExecute
  }
  const interrupt = await run('exec_command', { cmd: 'sleep 20', yield_time_ms: 10 })
  await run('write_stdin', { session_id: interrupt.session_id, chars: '\u0003', yield_time_ms: 250 })
  assert.equal(processes.at(-1).status, 'killed')
  const foreground = new AbortController()
  const running = run('exec_command', { cmd: 'sleep 20', yield_time_ms: 3000 }, foreground.signal)
  const timer = setTimeout(() => foreground.abort(new Error('foreground cancelled')), 150)
  await assert.rejects(running, /foreground cancelled/)
  clearTimeout(timer)
  assert.equal(processes.at(-1).status, 'killed')
  if (modern) assert.ok(specs.every(spec => spec.onExpiry === 'none'))
  console.log(`exec_command real DSH ${modern ? '0.2 execute' : '0.1 start'}: output, exit 7, promotion beyond 50ms timeout, write_stdin/job_output, job kill, interrupt and foreground cancellation PASS`)
} finally {
  await ctx.fiber.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
