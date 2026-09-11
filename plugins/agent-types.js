import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'codex-agent-types'
export const inject = ['settings', 'llm', 'webServer', 'agentPresets']
export const NAMESPACE = 'codex-agent-types'
export const JSON_LIMIT = 256 * 1024
export const BUILTIN_TYPES = Object.freeze([
  Object.freeze({ id: 'explorer', name: 'Explorer', description: 'Investigate and explain the codebase without changing it.' }),
  Object.freeze({ id: 'worker', name: 'Worker', description: 'Carry out one focused implementation task and verify it.' }),
  Object.freeze({ id: 'reviewer', name: 'Reviewer', description: 'Independently review changes for bugs, regressions and missing tests, without changing them.' }),
])
// A type is a DELEGATION PROFILE, not a role prompt: it selects the child's LLM
// route and native preset composition, and its description is the only text the
// parent reads when choosing. Every startup instruction comes from the caller's
// `prompt` argument, so a type contributes no model-facing text of its own.
const TypeSchema = z.object({
  id: z.string().required(), name: z.string().required(),
  description: z.string().required(),
  provider: z.string(), model: z.string(), reasoningEffort: z.string(), preset: z.string(),
})
export const TYPE_KEYS = Object.freeze(['id', 'name', 'description', 'provider', 'model', 'reasoningEffort', 'preset'])
// Removed in 0.3.0. Still accepted so an existing persisted section — or a
// cached pre-0.3.0 client bundle — cannot fail the settings validator at
// startup; it is dropped on both read and write, so the next save cleans it up.
export const LEGACY_TYPE_KEYS = Object.freeze(['instructions'])
export const Config = z.object({ types: z.array(TypeSchema).default(structuredClone(BUILTIN_TYPES)) })
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }
async function boundedLookup(work, deadline) {
  const remaining = Math.min(3000, deadline - Date.now())
  if (remaining <= 0) throw new Error('Metadata deadline exceeded')
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Metadata timeout')) }, remaining) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Project one record onto the canonical shape, dropping legacy/unknown keys.
 * The single chokepoint for both reads and writes, so a migrated field cannot
 * survive into the persisted section or reach the client. */
export function normalizeType(type) {
  const out = {}
  for (const key of TYPE_KEYS) if (type[key] !== undefined) out[key] = type[key]
  return out
}

export function validateTypes(types) {
  if (!Array.isArray(types) || types.length > 256) fail('types must be an array of at most 256 entries')
  const ids = new Set()
  for (const type of types) {
    if (!type || typeof type !== 'object' || Array.isArray(type)) fail('Invalid type')
    if (Object.keys(type).some(key => !TYPE_KEYS.includes(key) && !LEGACY_TYPE_KEYS.includes(key))) fail('Unknown type field')
    if (typeof type.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(type.id) || ids.has(type.id)) fail('Type ids must be unique lowercase identifiers')
    ids.add(type.id)
    for (const [key, limit] of [['name', 256], ['description', 4096]]) {
      if (typeof type[key] !== 'string' || type[key].length > limit || !type[key].trim()) fail(`Invalid ${key}`)
    }
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      if (type[key] !== undefined && (typeof type[key] !== 'string' || !type[key].trim() || type[key].length > 512)) fail(`Invalid ${key}`)
    }
    if ((type.provider === undefined) !== (type.model === undefined)) fail('provider and model must be set together')
    if (type.reasoningEffort !== undefined && type.model === undefined) fail('reasoningEffort requires an explicit provider/model')
    if (type.preset !== undefined && (typeof type.preset !== 'string' || type.preset.length > 512 || !/^[a-z0-9][a-z0-9-]*$/.test(type.preset))) fail('Invalid preset id')
  }
  for (const type of BUILTIN_TYPES) if (!ids.has(type.id)) fail(`Built-in type ${type.id} cannot be deleted`)
}

export function requireSameOrigin(req) {
  const origin = req.headers.origin
  const expected = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`
  if (typeof origin !== 'string' || origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) fail('Same-origin Origin header required', 403)
}

export async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail('Content-Type must be application/json', 415)
  if (Number(req.headers['content-length']) > JSON_LIMIT) fail('JSON body too large', 413)
  const chunks = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > JSON_LIMIT) fail('JSON body too large', 413)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('Malformed JSON') }
}

export class CodexAgentTypes extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'codexAgentTypes')
    this.listeners = new Set()
    const entry = { types: structuredClone(config.types ?? BUILTIN_TYPES) }
    this.source = () => entry
    ctx.settings.installSection(ctx, NAMESPACE, Config, entry, {
      setSource: source => { this.source = source },
      validate: value => validateTypes(value.types),
      onChange: () => {
        for (const listener of this.listeners) {
          try { Promise.resolve(listener(this.current())).catch(() => {}) } catch { /* Observers cannot veto commits. */ }
        }
      },
    })
    for (const path of ['state', 'models', 'presets']) ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: `/codex-agent-types/api/${path}`,
      handler: (req, res) => this.handle(path, req, res),
    }))
    ctx.effect(() => () => this.listeners.clear())
  }

  current() {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === NAMESPACE)
    const types = descriptor?.value.types ?? this.source().types
    // Normalizing on read is what keeps a legacy `instructions` field out of the
    // client payload and out of the catalog, without a persisted-section rewrite.
    return structuredClone({ revision: descriptor?.revision ?? 0, types: types.map(normalizeType) })
  }
  list() { return this.current().types }
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async replace(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['types', 'revision'].includes(key)) || !Number.isSafeInteger(body.revision) || body.revision < 0) fail('Expected {types, revision}')
    validateTypes(body.types)
    // Persist the canonical shape: a legacy field echoed by an old client is
    // accepted above and dropped here rather than being written back.
    const types = body.types.map(normalizeType)
    const providers = this.ctx.llm.listProviders()
    const checkedPresets = new Set()
    for (const type of types) {
      if (type.preset !== undefined && !checkedPresets.has(type.preset)) {
        let preset
        try { preset = await this.ctx.agentPresets.resolve(type.preset) }
        catch { fail(`Unavailable preset: ${type.preset}`) }
        if (preset.broken !== undefined) fail(`Preset is broken: ${type.preset}`)
        checkedPresets.add(type.preset)
      }
      if (type.provider === undefined) continue
      if (!providers.some(provider => provider.id === type.provider)) fail(`Unavailable provider: ${type.provider}`)
      // The native model catalog is advisory, not a routing allowlist.
      const info = await this.ctx.llm.resolveModelInfo(type.provider, type.model)
      if (type.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === type.reasoningEffort)) fail(`Unsupported reasoning effort for ${type.provider}/${type.model}`)
    }
    await this.ctx.settings.replace(NAMESPACE, { types }, body.revision)
    return this.current()
  }
  async presets() {
    // Native discovery is deliberately uncached: presets added mid-session
    // appear on the next refresh. Never return filesystem paths to the client.
    return { presets: (await this.ctx.agentPresets.list()).map(({ id, name, description, broken }) => ({
      id, ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(broken === undefined ? {} : { broken }),
    })) }
  }
  async models() {
    const providers = this.ctx.llm.listProviders()
    const models = []; const failures = []
    const deadline = Date.now() + 10000
    const parallel = async (items, action) => {
      let cursor = 0
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) await action(items[cursor++])
      }))
    }
    await parallel(providers, async provider => {
      try { models.push(...await boundedLookup(() => this.ctx.llm.listModels(provider.id), deadline)) }
      catch { failures.push({ provider: provider.id, error: 'Model catalog unavailable' }) }
    })
    await parallel(models.map((model, index) => ({ model, index })), async ({ model, index }) => {
      try { models[index] = { ...model, ...await boundedLookup(signal => this.ctx.llm.resolveModelInfo(model.provider, model.id, signal), deadline) } }
      catch { failures.push({ provider: model.provider, model: model.id, error: 'Model metadata unavailable' }) }
    })
    return structuredClone({ providers, models, failures })
  }
  async handle(path, req, res) {
    let status = 200; let body
    try {
      if (req.method === 'GET') body = path === 'state' ? this.current() : path === 'presets' ? await this.presets() : await this.models()
      else if (req.method === 'PUT' && path === 'state') {
        requireSameOrigin(req)
        body = await this.replace(await readJson(req))
      } else { res.setHeader('Allow', path === 'state' ? 'GET, PUT' : 'GET'); fail('Method not allowed', 405) }
    } catch (error) {
      status = error.code === 'SETTINGS_CONFLICT' ? 409 : error.status ?? 500
      body = { error: status === 500 ? 'Agent type service failed' : error.message, ...(status === 409 ? { current: this.current() } : {}) }
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
}

export function apply(ctx, config) { new CodexAgentTypes(ctx, config) }
