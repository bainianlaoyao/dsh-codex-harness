// Uses the installed official tool-subagent implementation, not a copied tool.
import assert from 'node:assert/strict'
import { apply } from './typed-subagents.js'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installPresetBridge, withPreset } from './typed-subagent-presets.js'

function fixture(config) {
  const tools = new Map(), events = new Map(), requests = [], preflights = [], disposed = []
  const created = [], compositions = []
  const donorPresets = new WeakMap()
  let types = ['explorer', 'worker', 'reviewer'].map(id => ({ id, name: id, description: `${id} work` }))
  const providers = new Map(['spawn', 'fork'].map(name => [name, {
    name, inheritsParentContext: name === 'fork', capabilities: { depthLimit: true, agentOptions: true }, prepareContinuable() {},
  }]))
  const ctx = {
    tools: { register(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); return () => tools.delete(tool.name) }, get: name => tools.get(name) },
    subagents: {
      getProvider: name => providers.get(name),
      async startContinuable(request) { requests.push(request); await materialize(request.request); return { childId: `child-${requests.length}` } },
      async start(provider, request) {
        requests.push({ provider, request })
        await materialize(request)
        return { id: 'foreground', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), dispose() { disposed.push(true) } }
      },
    },
    codexAgentTypes: { list: () => structuredClone(types) },
    agents: {
      ctx: new Context(),
      async create(options) {
        const log = []
        const child = { session: { header: options.meta, inheritedEventCount: 0, append(type, data) { log.push({ type, data }) }, snapshotEvents() { return log } } }
        ;(await options.setup?.(ctx, child))?.commit()
        created.push(child)
        return { agent: child }
      },
      async resume() { throw new Error('covered by native composition smoke') },
    },
    agentPresets: {
      async resolve(id) { if (id === 'missing') throw new Error('unknown preset'); return { id, ...(id === 'broken' ? { broken: 'unavailable plugin' } : {}) } },
      async mount(donorCtx, id) { donorPresets.set(donorCtx, id) },
      composeFrom(childCtx, donorCtx) { const id = donorPresets.get(donorCtx); if (id) compositions.push(id) },
    },
    sessionProjections: { register() {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    on(event, fn) { const handlers = events.get(event) ?? []; handlers.push(fn); events.set(event, handlers) },
    effect(fn) { return fn() },
    get(name) { return name === 'llm' ? { async resolveCallConfig(options) { preflights.push(options); await Promise.resolve(); if (options.reasoningEffort === 'invalid') throw new Error('unsupported effort') } } : this[name] },
    logger: { info() {} },
  }
  async function materialize(request) {
    return ctx.agents.create({ parentAgent: request.parent, meta: { origin: 'subagent', agentPreset: 'parent' }, setup(childCtx) { childCtx.get('agentPresets').composeFrom(childCtx, ctx) } })
  }
  apply(ctx, config)
  const exec = { agent: { options: { provider: 'parent', model: 'base', reasoningEffort: 'high' }, session: { requestHeader() {} } }, signal: new AbortController().signal }
  return {
    tools, events, requests, preflights, disposed, providers, ctx, exec, created, compositions,
    setTypes(value) { types = value },
    getTypes() { return structuredClone(types) },
    call(type, extra = {}, tool = 'subagent') { return tools.get(tool).execute({ description: 'Focused assigned task', prompt: 'Do the work', agent_type: type, ...extra }, exec) },
    async assemble() {
      let assembly = { sections: [], tools: [...tools.values()].map(({ name, parameters }) => ({ name, parameters: structuredClone(parameters) })) }
      for (const hook of events.get('system-prompt/assemble') ?? []) assembly = await hook(assembly, {}, async () => assembly)
      return assembly
    },
  }
}

const f = fixture()
assert.deepEqual([...f.tools.keys()], ['subagent', 'subagent_fork'])
for (const tool of f.tools.values()) {
  assert.ok(tool.parameters.required.includes('agent_type'))
  assert.ok(tool.parameters.required.includes('prompt'))
  assert.equal(tool.parameters.properties.provider, undefined, 'route overrides are host-owned, not arbitrary model arguments')
  assert.equal(tool.parameters.properties.preset, undefined)
  assert.equal(tool.isConcurrencySafe({ agent_type: 'worker', description: 'test', prompt: 'test' }), true)
}
await assert.rejects(f.call(undefined), /agent_type is required/)
await assert.rejects(f.call('missing'), /Unknown agent_type/)
await assert.rejects(f.call('worker', { prompt: 42 }), /prompt/)
await assert.rejects(f.call('worker', { provider: 'rogue' }), /child model selection is disabled/)
await assert.rejects(f.call('worker', { preset: 'rogue' }), /preset is host-owned/)
assert.equal(f.requests.length, 0)
const result = await f.call('explorer')
assert.equal(result.kind, 'continuable')
assert.equal(f.requests[0].request.persona, undefined, 'a type carries no role prompt: the caller prompt is the whole startup instruction')
assert.deepEqual(f.requests[0].request.prompt, [{ type: 'text', text: 'Do the work' }])
assert.equal(f.requests[0].request.agentOptions, undefined)
assert.equal(f.requests[0].request.maxDepth, 3)
assert.equal(f.preflights.length, 0, 'pure inheritance stays native')
assert.equal((await f.call('reviewer', { run_in_background: false }, 'subagent_fork')).kind, 'foreground')
assert.equal(f.requests.at(-1).provider, 'fork')
assert.equal(f.disposed.length, 1)

const presetTypes = fixture()
presetTypes.setTypes(presetTypes.getTypes().map(type => ({ ...type, ...(type.id === 'worker' ? {} : { preset: type.id }) })))
await Promise.all([presetTypes.call('explorer'), presetTypes.call('reviewer', { run_in_background: false }, 'subagent_fork'), presetTypes.call('worker')])
assert.deepEqual(presetTypes.compositions.sort(), ['explorer', 'reviewer'])
assert.deepEqual(presetTypes.created.map(child => child.session.header.agentPreset).sort(), ['explorer', 'parent', 'reviewer'])
for (const child of presetTypes.created) {
  const events = child.session.snapshotEvents()
  assert.equal(events.length, child.session.header.agentPreset === 'parent' ? 0 : 1)
}
for (const preset of ['', null, 42, 'missing', 'broken']) {
  presetTypes.setTypes([{ id: 'test', name: 'Test', description: 'Test', preset }])
  await assert.rejects(presetTypes.call('test'), /invalid preset|unknown preset|broken/)
}
assert.equal(presetTypes.created.length, 3, 'invalid presets never create a child')

const isolation = fixture()
const parent = isolation.exec.agent
await withPreset(isolation.ctx, true, 'selected', parent, async () => {
  await isolation.ctx.agents.create({ parentAgent: parent, meta: { origin: 'other' } })
  await isolation.ctx.agents.create({ parentAgent: {}, meta: { origin: 'subagent' } })
  await withPreset(isolation.ctx, true, undefined, parent, () => isolation.ctx.agents.create({ parentAgent: parent, meta: { origin: 'subagent' } }))
  await isolation.ctx.agents.create({ parentAgent: parent, meta: { origin: 'subagent' }, setup(childCtx) { childCtx.get('agentPresets').composeFrom(childCtx, isolation.ctx) } })
  await isolation.ctx.agents.create({ parentAgent: parent, meta: { origin: 'subagent' } })
})
assert.deepEqual(isolation.compositions, ['selected'], 'only one matching direct delegation claims the selection')
assert.deepEqual(isolation.created.map(child => child.session.header.agentPreset), [undefined, undefined, undefined, 'selected', undefined])

const originalCreate = () => {}
const unsupportedRegistry = { create: originalCreate }
assert.throws(() => installPresetBridge({ get: () => unsupportedRegistry }), /agents.resume is unavailable/)
assert.equal(unsupportedRegistry.create, originalCreate, 'unsupported native interface leaves no partially installed wrapper')
const rollbackTarget = { create: originalCreate, resume() {} }
const rollbackRegistry = new Proxy(rollbackTarget, { defineProperty(target, key, descriptor) {
  if (key === 'resume') throw new Error('installation refused')
  return Reflect.defineProperty(target, key, descriptor)
} })
assert.throws(() => installPresetBridge({ get: () => rollbackRegistry }), /installation refused/)
assert.equal(rollbackTarget.create, originalCreate, 'failed second installation restores the first method')

const assembly = await f.assemble()
assert.deepEqual(assembly.tools[0].parameters.properties.agent_type.enum, ['explorer', 'worker', 'reviewer'])
assert.match(assembly.sections[0].text, /Choose explorer/)
assert.match(assembly.sections[0].text, /carries no instructions of its own/, 'the prompt-assembly guidance must state that the caller owns the startup instruction')
assert.match(assembly.sections[0].text, /complete startup instruction/)
f.setTypes([...f.getTypes(), { id: 'special', name: 'Specialist', description: 'Special tasks', provider: 'other', model: 'new' }])
const next = await f.assemble()
assert.ok(next.tools[0].parameters.properties.agent_type.enum.includes('special'))
assert.match(next.sections[0].text, /special \(Specialist\)/)
assert.ok(!assembly.tools[0].parameters.properties.agent_type.enum.includes('special'), 'previous request snapshot is unchanged')
await f.call('special')
assert.deepEqual(f.preflights.at(-1), { provider: 'other', model: 'new' }, 'changed route clears parent effort')

f.setTypes([...f.getTypes(), { id: 'effort', name: 'Effort', description: 'Same route effort', reasoningEffort: 'low' }])
const start = f.requests.length
await Promise.all([f.call('special'), f.call('effort', {}, 'subagent_fork'), f.call('worker')])
const concurrent = f.requests.slice(start)
assert.deepEqual(concurrent.map(r => r.request.persona), [undefined, undefined, undefined], 'no request carries a configured persona')
assert.deepEqual(concurrent.find(r => r.request.agentOptions?.provider === 'other').request.agentOptions, { provider: 'other', model: 'new' })
assert.deepEqual(concurrent.find(r => r.request.agentOptions?.reasoningEffort === 'low').request.agentOptions, { reasoningEffort: 'low' })
assert.equal(concurrent.filter(r => r.request.agentOptions === undefined).length, 1, 'the inherited-route type stays native')
assert.ok(f.preflights.some(route => route.provider === 'parent' && route.model === 'base' && route.reasoningEffort === 'low'))

f.setTypes([{ id: 'invalid', name: 'Invalid', description: 'Bad effort', reasoningEffort: 'invalid' }])
await assert.rejects(f.call('invalid'), /unsupported effort/)
await assert.rejects(f.call('special'), /Unknown agent_type/, 'deleted types cannot run')
f.providers.get('spawn').capabilities.agentOptions = false
await assert.rejects(f.call('invalid'), /does not support child agentOptions/)
assert.throws(() => fixture({ maxDepth: -1 }), /depth/i)
const cancelled = fixture()
const controller = new AbortController(); controller.abort()
cancelled.exec.signal = controller.signal
await assert.rejects(cancelled.call('worker'), /abort/i)
assert.equal(cancelled.requests.length, 0)

const lifecycle = fixture()
for (const hook of lifecycle.events.get('subagent/provider-removed')) hook('spawn')
assert.equal(lifecycle.tools.has('subagent'), false)
for (const hook of lifecycle.events.get('subagent/provider-added')) hook(lifecycle.providers.get('spawn'))
assert.ok(lifecycle.tools.get('subagent').parameters.required.includes('agent_type'))

// Real Cordis scoped service registration and real prompt waterfall composition.
const root = new Context()
new SystemPrompt(root, {})
new ToolRuntime(root)
const backing = fixture()
root.provide('subagents', backing.ctx.subagents)
root.provide('sessionProjections', backing.ctx.sessionProjections)
root.provide('codexAgentTypes', backing.ctx.codexAgentTypes)
const key = {}
const scope = createScope(root, key)
apply(scope.ctx)
assert.equal(root.tools.get('subagent'), undefined, 'typed tools must not leak into Host scope')
assert.ok(root.tools.get('subagent', key).parameters.required.includes('agent_type'))
let downstream = 0
scope.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { downstream++; return next() })
const firstReal = await root.systemPrompt.assemble({ scope: key })
assert.match(firstReal.sections.find(s => s.name === 'codex:agent-types').text, /explorer/)
backing.setTypes([...backing.getTypes(), { id: 'live', name: 'Live', description: 'Added live' }])
const secondReal = await root.systemPrompt.assemble({ scope: key })
assert.match(secondReal.sections.find(s => s.name === 'codex:agent-types').text, /Added live/)
assert.equal(downstream, 2, 'other prompt middleware must not be swallowed')
await scope.dispose()
assert.equal(root.tools.get('subagent', key), undefined, 'scope disposal cleans native registrations')
console.log('typed-subagents smoke: ALL PASS (native validation/lifecycle, dynamic catalog, route preflight, parallel isolation)')
