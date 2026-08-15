/**
 * Smoke test for dsh-codex/tools/multi-agent.js — mock `ctx.subagents`
 * (startContinuable/followup/interrupt) and the agent registry, covering the
 * five codex Collab V1 tools: spawn, send (with/without interrupt), resume,
 * wait (settled + timeout), close — plus the codex message-vs-items and
 * timeout/targets validations.
 *
 * Usage: node dsh-codex/tools/multi-agent.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
const followups = []
const interrupts = []
const startedRequests = []
let nextChild = 1
let childStatus = 'running'

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  subagents: {
    async startContinuable({ provider, request, signal }) {
      assert.equal(provider, 'spawn', 'provider from config')
      startedRequests.push({ prompt: request.prompt, agentOptions: request.agentOptions })
      return { childId: `child-${nextChild++}`, messageId: 'msg-1' }
    },
    async followup(parent, childId, content, options) {
      followups.push({ childId: String(childId), text: content[0].text, sender: String(options.source.senderSessionId) })
      return `msg-${followups.length + 1}`
    },
    interrupt(childId, authority) {
      interrupts.push({ childId: String(childId), authority: authority.kind })
    },
  },
  get(service) {
    if (service === 'agents')
      return {
        get(id) {
          if (String(id).startsWith('child-')) return { status: childStatus }
          return undefined
        },
      }
    return undefined
  },
}

const { apply } = await import('./multi-agent.js')
apply(ctx, { provider: 'spawn' })

const byName = Object.fromEntries(captured.map((tool) => [tool.name, tool]))
for (const name of ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent'])
  assert.ok(byName[name], `${name} registered`)

const parent = { id: 'parent-1', session: { header: { cwd: 'C:/tmp' } } }
const makeExec = (callId) => ({ agent: parent, signal: new AbortController().signal, callId })
const run = (name, args, exec = makeExec('call-1')) => byName[name].execute(args, exec)

// ── spawn → send → wait → close ────────────────────────────────────────────
const spawned = await run('spawn_agent', { message: 'do the thing', model: 'gpt-5' })
assert.equal(spawned.agent_id, 'child-1')
assert.equal(spawned.nickname, null, 'nickname is null (DSH seam has no nickname)')
assert.deepEqual(startedRequests[0].prompt, [{ type: 'text', text: 'do the thing' }])
assert.deepEqual(startedRequests[0].agentOptions, { model: 'gpt-5' })

const sent = await run('send_input', { target: 'child-1', message: 'also this' })
assert.equal(followups[0].childId, 'child-1')
assert.equal(followups[0].text, 'also this')
assert.equal(sent.submission_id, 'msg-2')

await run('send_input', { target: 'child-1', message: 'urgent', interrupt: true })
assert.equal(interrupts.length, 1, 'interrupt flag cancels first')
assert.equal(interrupts[0].childId, 'child-1')

const resumed = await run('resume_agent', { id: 'child-1' })
assert.equal(followups[followups.length - 1].text, 'Continue.', 'resume sends neutral continue')
assert.equal(resumed.status, 'running', 'resume returns the observed status')

childStatus = 'idle'
const waited = await run('wait_agent', { targets: ['child-1'], timeout_ms: 10000 })
assert.equal(waited.timed_out, false)
assert.deepEqual(waited.status, { 'child-1': 'idle' }, 'status map keyed by id')

childStatus = 'running'
const timed = await run('wait_agent', { targets: ['child-1'], timeout_ms: 10000 })
assert.equal(timed.timed_out, true, 'running child times out the wait')
assert.deepEqual(timed.status, { 'child-1': 'running' })

const closed = await run('close_agent', { target: 'child-1' })
assert.equal(closed.previous_status, 'running', 'close returns previous status')
assert.equal(interrupts[interrupts.length - 1].childId, 'child-1')

// ── spawn with structured items (and no message) ───────────────────────────
const itemSpawn = await run('spawn_agent', { items: [{ type: 'text', text: 'from items' }] })
assert.equal(itemSpawn.agent_id, 'child-2')
assert.equal(itemSpawn.nickname, null)
assert.deepEqual(startedRequests[startedRequests.length - 1].prompt, [{ type: 'text', text: 'from items' }])

// ── message-vs-items validation ────────────────────────────────────────────
await assert.rejects(
  () => run('send_input', { target: 'child-1', message: 'x', items: [{ type: 'text', text: 'y' }] }),
  /Provide either message or items, but not both/,
  'both message and items rejected'
)
await assert.rejects(
  () => run('send_input', { target: 'child-1' }),
  /Provide one of: message or items/,
  'neither message nor items rejected'
)
await assert.rejects(
  () => run('send_input', { target: 'child-1', message: '   ' }),
  /Empty message can't be sent to an agent/,
  'empty message rejected'
)
await assert.rejects(
  () => run('send_input', { target: 'child-1', items: [] }),
  /Items can't be empty/,
  'empty items rejected'
)
await assert.rejects(
  () => run('spawn_agent', {}),
  /Provide one of: message or items/,
  'spawn with neither message nor items rejected'
)

// ── wait_agent timeout/targets validation ──────────────────────────────────
await assert.rejects(
  () => run('wait_agent', { targets: [], timeout_ms: 10000 }),
  /agent ids must be non-empty/,
  'empty targets rejected'
)
await assert.rejects(
  () => run('wait_agent', { targets: ['child-1'], timeout_ms: 0 }),
  /timeout_ms must be greater than zero/,
  'zero timeout rejected'
)
await assert.rejects(
  () => run('wait_agent', { targets: ['child-1'], timeout_ms: -5 }),
  /timeout_ms must be greater than zero/,
  'negative timeout rejected'
)

// ── schema parity ───────────────────────────────────────────────────────────
assert.ok(!(byName.spawn_agent.parameters.required ?? []).includes('message'), 'spawn message NOT required')
for (const field of ['items', 'fork_context', 'agent_type', 'model', 'service_tier', 'reasoning_effort'])
  assert.ok(byName.spawn_agent.parameters.properties[field] !== undefined, `spawn_agent has ${field}`)
assert.ok((byName.send_input.parameters.required ?? []).includes('target'), 'send_input target required')
assert.ok((byName.wait_agent.parameters.required ?? []).includes('targets'), 'wait_agent targets required')
assert.ok(byName.wait_agent.parameters.properties.targets !== undefined, 'wait_agent targets param')
assert.deepEqual(byName.send_input.output.schema.required, ['submission_id'], 'send_input output is submission_id')
assert.deepEqual(byName.spawn_agent.output.schema.required, ['agent_id', 'nickname'], 'spawn output is agent_id+nickname')
assert.deepEqual(byName.close_agent.output.schema.required, ['previous_status'], 'close output is previous_status')
assert.deepEqual(byName.resume_agent.output.schema.required, ['status'], 'resume output is status')

console.log('multi-agent smoke test: ALL PASS')
