import assert from 'node:assert/strict'
import { apply } from './exec-command.js'
const definitions = new Map(), handles = []
const owner = { id: 'contract', session: { id: 'contract', header: { cwd: process.cwd() } }, ctx: { effect: () => () => {} } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function processHandle() {
  let complete
  const handle = { status: 'running', exitCode: null, done: new Promise(resolve => { complete = resolve }),
    readOutput: () => ({ delta: 'fixture\n', lossy: false }),
    kill() { this.status = 'killed'; complete() },
    finish() { this.status = 'completed'; this.exitCode = 0; complete() },
  }
  handles.push(handle)
  return handle
}
let jobs
let execute = async spec => { const proc = processHandle(); proc.finish(); return proc }
const ctx = { tools: { register: tool => definitions.set(tool.name, tool) }, fs: {}, get: name => name === 'jobs' ? jobs : undefined, shell: {
  async resolve(request) { await delay(1); return { ...request, onExpiry: request.onExpiry ?? 'kill' } },
  async execute(spec) {
    assert.equal(spec.onExpiry, 'none')
    assert.ok(spec.signal instanceof AbortSignal)
    return execute(spec)
  },
  start() { throw new Error('must prefer execute') },
} }
apply(ctx, { yieldFloorMs: 1 })
const run = signal => definitions.get('exec_command').execute({ cmd: 'fixture', yield_time_ms: 1 }, { agent: owner, signal, callId: 'fixture' })
assert.equal((await run(new AbortController().signal)).exit_code, 0)
execute = async () => { await delay(1); throw new Error('async preparation failed') }
await assert.rejects(run(new AbortController().signal), /^Error: exec_command failed: async preparation failed$/)
execute = async () => { const proc = processHandle(); proc.finish(); proc.result = async () => { throw new Error('provider failed') }; return proc }
await assert.rejects(run(new AbortController().signal), /exec_command failed: provider failed/)
const before = handles.length
const already = new AbortController(); already.abort(new Error('already aborted'))
await assert.rejects(run(already.signal), /already aborted/)
assert.equal(handles.length, before)
const preparing = new AbortController()
execute = spec => new Promise((resolve, reject) => {
  spec.signal.addEventListener('abort', () => reject(spec.signal.reason), { once: true })
  setTimeout(() => preparing.abort(new Error('preparation cancelled')), 5)
})
await assert.rejects(run(preparing.signal), /preparation cancelled/)
const late = new AbortController()
execute = async () => { late.abort(new Error('late handle')); await delay(1); return processHandle() }
await assert.rejects(run(late.signal), /late handle/)
assert.equal(handles.at(-1).status, 'killed', 'a handle published after cancellation must be joined and killed')
const promotion = new AbortController()
jobs = { readAt() {}, start(spec) {
  assert.equal(spec.owner, owner.id)
  const hooks = spec.run()
  hooks.done.catch(() => {})
  promotion.abort(new Error('promotion cancelled'))
  return 'exec-cancelled'
} }
apply(ctx, { yieldFloorMs: 1 })
execute = async () => processHandle()
await assert.rejects(run(promotion.signal), /promotion cancelled/)
assert.equal(handles.at(-1).status, 'killed')
await assert.rejects(definitions.get('write_stdin').execute({ session_id: 'exec-cancelled' },
  { agent: owner, signal: new AbortController().signal }), /Unknown process/)
console.log('exec_command async contract: execute preference, async resolve/preparation, deadlines, failures and cancellation PASS')
