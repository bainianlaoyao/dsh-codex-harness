import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { BUILTIN_TYPES, CodexAgentTypes, JSON_LIMIT, NAMESPACE, readJson, requireSameOrigin, validateTypes } from './agent-types.js'
import * as plugin from './agent-types.js'

let stored = {}
class MemorySettings extends SettingsProvider {
  writable = true
  async load() { return structuredClone(stored) }
  async persist(ns, section) { stored[ns] = structuredClone(section) }
}
class Models extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  listProviders() { return [{ id: 'native', name: 'Native' }] }
  async listModels() { return [{ provider: 'native', id: 'model', name: 'Model' }] }
  async resolveModelInfo(provider, id) { return { provider, id, name: 'Model', reasoning: { efforts: [{ id: 'max', name: 'Maximum' }], defaultEffort: 'max' } } }
}
class Routes extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = new Map() }
  register(route) { this.routes.set(route.path, route); return () => this.routes.delete(route.path) }
}
class Presets extends Service {
  constructor(ctx) {
    super(ctx, 'agentPresets')
    this.rows = [{ id: 'code', name: 'Code', description: 'Coding tools', path: '/private/preset/agent.cordis.yml' }, { id: 'broken', broken: 'Invalid composition' }]
  }
  async list() { return structuredClone(this.rows) }
  async resolve(id) {
    const preset = this.rows.find(row => row.id === id)
    if (!preset) throw new Error('Unknown preset')
    return structuredClone(preset)
  }
}
async function boot() {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Models)
  await ctx.plugin(Routes)
  await ctx.plugin(Presets)
  await ctx.plugin(plugin)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.codexAgentTypes)
  return ctx
}
function request(body, headers = {}) {
  const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)])
  req.headers = { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json', ...headers }
  req.method = 'PUT'
  return req
}
async function http(service, path, req) {
  const res = { setHeader() {}, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await service.handle(path, req, res)
  return res
}

const ctx = await boot()
try {
  const service = ctx.codexAgentTypes
  const initial = service.current()
  assert.deepEqual(initial.types, BUILTIN_TYPES)
  initial.types[0].name = 'mutation'
  assert.equal(service.list()[0].name, 'Explorer')
  const custom = { id: 'custom', name: 'Custom', description: 'Custom tasks.', provider: 'native', model: 'model', reasoningEffort: 'max', preset: 'code' }
  const next = { revision: service.current().revision, types: [...service.list(), custom] }
  let observed
  const off = service.subscribe(state => { observed = state; state.types[0].name = 'observer mutation' })
  const results = await Promise.all([http(service, 'state', request(next)), http(service, 'state', request(next))])
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409])
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(observed)
  off()
  assert.equal(service.list()[0].name, 'Explorer')
  assert.equal(stored[NAMESPACE].types.at(-1).id, 'custom')
  assert.equal(stored[NAMESPACE].types.at(-1).preset, 'code')
  assert.equal(Object.hasOwn(stored[NAMESPACE].types.at(-1), 'instructions'), false, 'types carry no instructions')
  // `instructions` was removed in 0.3.0. A stale persisted section or a cached
  // pre-0.3.0 client bundle must still validate, and the field must never be
  // written back or surface on read.
  await service.replace({ revision: service.current().revision, types: [...service.list().slice(0, 3), { ...custom, instructions: 'Legacy role text.' }] })
  assert.equal(Object.hasOwn(service.list().at(-1), 'instructions'), false, 'legacy instructions never surface on read')
  assert.equal(Object.hasOwn(stored[NAMESPACE].types.at(-1), 'instructions'), false, 'legacy instructions are not persisted')
  assert.equal(service.list().at(-1).description, 'Custom tasks.', 'the surviving fields are untouched by the migration')
  assert.throws(() => validateTypes([{ id: 'rogue', name: 'Rogue', description: 'D', arbitrary: 1 }]), /Unknown type field/)
  const roster = await service.presets()
  assert.deepEqual(roster.presets[0], { id: 'code', name: 'Code', description: 'Coding tools' })
  assert.equal(roster.presets[1].broken, 'Invalid composition')
  ctx.agentPresets.rows.push({ id: 'new-preset', name: 'New preset' })
  const presetsRequest = request(''); presetsRequest.method = 'GET'
  const refreshed = await http(service, 'presets', presetsRequest)
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.presets.at(-1).id, 'new-preset', 'new presets are discovered during a session')
  assert.deepEqual((await service.models()).models[0].reasoning.efforts, [{ id: 'max', name: 'Maximum' }])
  const originalResolve = ctx.llm.resolveModelInfo
  ctx.llm.resolveModelInfo = async () => { throw new Error('Unavailable') }
  const partial = await service.models()
  assert.equal(partial.models.length, 1)
  assert.equal(partial.failures.length, 1)
  ctx.llm.resolveModelInfo = originalResolve
  for (const patch of [{ preset: '' }, { preset: '../code' }, { preset: 'missing' }, { preset: 'broken' }, { description: '' }, { reasoningEffort: 'off' }, { provider: 'missing' }, { model: undefined }, { id: 'worker' }]) {
    const response = await http(service, 'state', request({ revision: service.current().revision, types: [...service.list().slice(0, 3), { ...custom, ...patch }] }))
    assert.equal(response.status, 400)
  }
  assert.equal((await http(service, 'state', request(next, { origin: 'http://evil.example' }))).status, 403)
  assert.equal((await http(service, 'state', request(next, { origin: undefined }))).status, 403)
  assert.equal((await http(service, 'state', request('{'))).status, 400)
  assert.equal((await http(service, 'state', request(next, { 'content-type': 'text/plain' }))).status, 415)
  assert.equal((await http(service, 'state', request(' '.repeat(JSON_LIMIT + 1)))).status, 413)
  assert.throws(() => validateTypes([]), /cannot be deleted/)
  assert.throws(() => requireSameOrigin(request(next, { 'sec-fetch-site': 'cross-site' })))
  await assert.rejects(readJson(request('', { 'content-length': String(JSON_LIMIT + 1) })), /too large/)
  await service.replace({ revision: service.current().revision, types: service.list().map(type => type.id === 'custom' ? { ...type, name: 'Edited' } : type) })
  assert.equal(service.list().at(-1).name, 'Edited')
} finally { await ctx.fiber.dispose() }

const restarted = await boot()
try {
  assert.equal(restarted.codexAgentTypes.list().at(-1).name, 'Edited', 'settings survive service restart')
  assert.equal(restarted.codexAgentTypes.list().at(-1).preset, 'code', 'preset survives service restart')
  await restarted.codexAgentTypes.replace({ revision: restarted.codexAgentTypes.current().revision, types: restarted.codexAgentTypes.list().map(({ preset, ...type }) => type) })
  assert.equal(restarted.codexAgentTypes.list().at(-1).preset, undefined, 'omitted preset restores parent inheritance')
  await restarted.codexAgentTypes.replace({ revision: restarted.codexAgentTypes.current().revision, types: structuredClone(BUILTIN_TYPES) })
  assert.equal(restarted.codexAgentTypes.list().length, 3)
} finally { await restarted.fiber.dispose() }

// Upgrading from 0.2.x: the persisted section still carries `instructions`, and
// the registration hook validates the RESOLVED value — so a validator that
// rejected the legacy field as unknown would fail the whole plugin at startup.
stored = { [NAMESPACE]: { types: [
  { id: 'explorer', name: 'Explorer', description: 'Legacy explorer.', instructions: 'You are explorer. Never edit files.' },
  { id: 'worker', name: 'Worker', description: 'Legacy worker.', instructions: 'You are worker.' },
  { id: 'reviewer', name: 'Reviewer', description: 'Legacy reviewer.', instructions: 'You are reviewer.' },
  { id: 'legacy-custom', name: 'Legacy Custom', description: 'Saved under 0.2.x.', instructions: 'Old role text.', provider: 'native', model: 'model' },
] } }
const upgraded = await boot()
try {
  const migrated = upgraded.codexAgentTypes.current()
  assert.equal(migrated.types.length, 4, 'legacy records survive the upgrade')
  for (const type of migrated.types) {
    assert.equal(Object.hasOwn(type, 'instructions'), false, `${type.id} must not surface instructions`)
    assert.ok(type.description.trim(), `${type.id} keeps its description`)
  }
  assert.equal(migrated.types.at(-1).provider, 'native', 'route fields survive the migration')
  assert.equal(migrated.types.at(-1).model, 'model')
  // A cached 0.2.x client echoing the field back is accepted, and the write is clean.
  await upgraded.codexAgentTypes.replace({ revision: migrated.revision, types: migrated.types.map(type => type.id === 'legacy-custom' ? { ...type, instructions: 'stale echo' } : type) })
  assert.equal(Object.hasOwn(stored[NAMESPACE].types.at(-1), 'instructions'), false, 'the persisted section is cleaned on write')
  assert.deepEqual(upgraded.codexAgentTypes.list(), migrated.types, 'the rewritten catalog matches the read catalog')
} finally { await upgraded.fiber.dispose() }
console.log('agent-types smoke: PASS (native settings CAS, persistence reload, models, validation, legacy migration, HTTP guards)')
