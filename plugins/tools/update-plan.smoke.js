/**
 * M1 smoke test for dsh-codex/tools/update-plan.js — mock ctx with a captured
 * `tools.register` and an `inject(['sessionProjections'], …)` seam, verifying
 * the projection unit (init/apply/view/stateVersion) and the `plan/write`
 * session append from execute().
 *
 * Usage: node dsh-codex/tools/update-plan.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
let registeredProjection = null

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['sessionProjections'], 'injects sessionProjections')
    callback({
      sessionProjections: {
        register: (definition) => {
          registeredProjection = definition
          return () => {}
        },
      },
    })
  },
}

const { apply } = await import('./update-plan.js')
apply(ctx, {})

const tool = captured.find((t) => t.name === 'update_plan')
assert.ok(tool, 'update_plan registered')
assert.ok(registeredProjection, 'plan projection registered')
assert.equal(registeredProjection.key, 'plan', 'projection key')
assert.equal(registeredProjection.stateVersion, 1, 'projection stateVersion')
assert.equal(registeredProjection.init(), null, 'projection init is null')

const appended = []
const makeExec = () => ({
  agent: { session: { header: { cwd: 'C:/tmp' }, append: (type, data) => appended.push([type, data]) }, ctx: { effect: () => () => {} } },
  signal: new AbortController().signal,
  callId: 'call-1',
})

const plan = [
  { step: 'Write parser', status: 'in_progress' },
  { step: 'Write smoke tests', status: 'pending' },
  { step: 'Deliver', status: 'completed' },
]
const value = await tool.execute({ plan, explanation: 'mid-flight' }, makeExec())

assert.deepEqual(appended, [['plan/write', { plan }]], 'session append carries plan/write snapshot')
assert.deepEqual(value.plan, plan, 'canonical plan echoed')
assert.deepEqual(value.counts, { pending: 1, in_progress: 1, completed: 1 }, 'counts (snake_case keys)')

// ── projection semantics: last-write-wins, reset on turn start ─────────────
const applyEvent = (state, event) => registeredProjection.apply(state, event)
assert.deepEqual(applyEvent(null, { type: 'plan/write', data: { plan } }), plan, 'plan/write sets state')
assert.equal(applyEvent(plan, { type: 'turn/start' }), null, 'turn/start resets state')
assert.deepEqual(applyEvent(plan, { type: 'something/else' }), plan, 'other events keep state')
assert.deepEqual(registeredProjection.view(plan), plan, 'view is identity')

// ── render ─────────────────────────────────────────────────────────────────
const text = tool.output.render({ plan }, value)[0].text
assert.equal(text, 'Plan updated', 'render text is the codex literal')
const present = tool.presentCall({ plan })
assert.equal(present.title, 'Update plan', 'presentCall title')
assert.deepEqual(present.rawInput, plan, 'presentCall rawInput is the plan array')

// ── validation: agent required; codex accepts empty/multiple-in_progress ──
await assert.rejects(
  () => tool.execute({ plan }, { signal: new AbortController().signal }),
  /update_plan requires an owning agent session/,
  'agent required'
)
const multiInProgress = await tool.execute(
  { plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] },
  makeExec()
)
assert.equal(multiInProgress.counts.in_progress, 2, 'multiple in_progress accepted')
const emptyPlan = await tool.execute({ plan: [] }, makeExec())
assert.deepEqual(emptyPlan.plan, [], 'empty plan accepted')
assert.deepEqual(emptyPlan.counts, { pending: 0, in_progress: 0, completed: 0 }, 'empty plan counts are zero')
const emptyStep = await tool.execute({ plan: [{ step: '', status: 'pending' }] }, makeExec())
assert.deepEqual(emptyStep.plan, [{ step: '', status: 'pending' }], 'empty step string accepted')

// ── schema spot checks (converted to JSON Schema by defineTool) ────────────
assert.ok(tool.parameters.required.includes('plan'), 'plan required')
assert.ok(!tool.parameters.required.includes('explanation'), 'explanation optional')
assert.deepEqual(tool.parameters.properties.plan.items.required, ['step', 'status'], 'item fields required')
assert.deepEqual(
  tool.parameters.properties.plan.items.properties.status.enum,
  ['pending', 'in_progress', 'completed'],
  'status enum'
)

console.log('update-plan smoke test: ALL PASS')
