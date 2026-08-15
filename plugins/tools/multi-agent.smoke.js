/**
 * Smoke test for dsh-codex/tools/multi-agent.js — mock `ctx.subagents`
 * (startContinuable/followup/interrupt) and the agent registry, covering the
 * five codex Collab V1 tools: spawn, send (with/without interrupt), resume,
 * wait (settled + timeout), close.
 *
 * Usage: node dsh-codex/tools/multi-agent.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
const followups = []
const interrupts = []
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

const startedRequests = []
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
assert.deepEqual(startedRequests[0].prompt, [{ type: 'text', text: 'do the thing' }])
assert.deepEqual(startedRequests[0].agentOptions, { model: 'gpt-5' })

const sent = await run('send_input', { target: 'child-1', message: 'also this' })
assert.equal(followups[0].childId, 'child-1')
assert.equal(followups[0].text, 'also this')
assert.equal(sent.message_id, 'msg-2')

await run('send_input', { target: 'child-1', message: 'urgent', interrupt: true })
assert.equal(interrupts.length, 1, 'interrupt flag cancels first')
assert.equal(interrupts[0].childId, 'child-1')

const resumed = await run('resume_agent', { id: 'child-1' })
assert.equal(followups[followups.length - 1].text, 'Continue.', 'resume sends neutral continue')

childStatus = 'idle'
const waited = await run('wait_agent', { agents: ['child-1'], timeout_ms: 10000 })
assert.equal(waited.timed_out, false)
assert.deepEqual(waited.agents, [{ id: 'child-1', status: 'idle' }])

childStatus = 'running'
const timed = await run('wait_agent', { agents: ['child-1'], timeout_ms: 10000 })
assert.equal(timed.timed_out, true, 'running child times out the wait')
assert.deepEqual(timed.agents, [{ id: 'child-1', status: 'running' }])

const closed = await run('close_agent', { target: 'child-1' })
assert.equal(closed.accepted, true)
assert.equal(interrupts[interrupts.length - 1].childId, 'child-1')

// ── schema parity ───────────────────────────────────────────────────────────
assert.ok((byName.spawn_agent.parameters.required ?? []).includes('message'), 'spawn message required')
for (const field of ['agent_type', 'model', 'service_tier', 'reasoning_effort'])
  assert.ok(byName.spawn_agent.parameters.properties[field] !== undefined, `spawn_agent has ${field}`)
assert.ok(byName.wait_agent.parameters.properties.timeout_ms !== undefined, 'wait timeout param')

console.log('multi-agent smoke test: ALL PASS')
