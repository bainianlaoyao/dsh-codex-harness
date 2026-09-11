/** Preset-scoped adapter over the public native delegation plugin (no package patches).
 * Host seam: codexAgentTypes.list() -> (Promise of) user-defined type records.
 * Records: { id, name, description, provider?, model?, reasoningEffort?, preset? }.
 * preset is a native AgentPresets roster id, not a filesystem path; omitted inherits.
 * A type is a delegation profile only — it configures the child's LLM route and its
 * native preset composition. The child's entire startup instruction is the caller's
 * `prompt` argument: this adapter never injects model-facing text of its own, so the
 * native `persona` request field stays unset.
 * Host returns the complete catalog, including explorer/worker/reviewer defaults.
 * The host owns persistence/authorization. Both prompt assembly and execution read
 * fresh snapshots, so no reload, subscription, or mutable tool registration is needed.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { apply as applyNative } from '@deepseek-ai/dsh-tool-subagent'
import { installPresetBridge, withPreset } from './typed-subagent-presets.js'

export const name = 'codex-typed-subagents'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections', 'codexAgentTypes']

async function catalog(service) {
  const records = await service.list()
  if (!Array.isArray(records)) throw new Error('codexAgentTypes.list() must return an array')
  const types = []
  const seen = new Set()
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(record.id)) {
      throw new Error('agent type id must match /^[a-z][a-z0-9_-]{0,63}$/')
    }
    if (seen.has(record.id)) throw new Error(`duplicate agent type: ${record.id}`)
    seen.add(record.id)
    const type = { id: record.id }
    for (const key of ['name', 'description', 'provider', 'model', 'reasoningEffort', 'preset']) {
      if (record[key] === undefined) continue
      if (typeof record[key] !== 'string' || !record[key].trim()) throw new Error(`agent type ${record.id}: invalid ${key}`)
      type[key] = record[key]
    }
    if (!type.name || type.description === undefined) throw new Error(`agent type ${record.id}: name and description are required`)
    types.push(type)
  }
  return types
}

function optionsFor(type) {
  const options = {}
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (type[key] !== undefined) options[key] = type[key]
  }
  return Object.keys(options).length ? options : undefined
}

// Preserve Cordis service/accessor receivers and scoped registration ownership.
function facade(target, overrides) {
  return new Proxy(target, { get(object, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key]
    const value = Reflect.get(object, key, object)
    return typeof value === 'function' ? value.bind(object) : value
  } })
}

export function apply(ctx, config = {}) {
  const selection = new AsyncLocalStorage()
  const presetBridge = installPresetBridge(ctx)
  const host = ctx.codexAgentTypes
  const readTypes = () => catalog(host)
  for (const [toolName, provider] of [['subagent', 'spawn'], ['subagent_fork', 'fork']]) {
    const tools = facade(ctx.tools, {
      register(native) {
        const parameters = structuredClone(native.parameters)
        parameters.properties.agent_type = { type: 'string', minLength: 1, description: 'Required agent type name from the current Agent types directory. Choose the narrowest suitable specialization.' }
        parameters.required = [...new Set([...(parameters.required ?? []), 'agent_type'])]
        return ctx.tools.register({
          ...native,
          parameters,
          description: native.description + ' You must supply agent_type; consult the current Agent types directory before choosing.',
          isConcurrencySafe(args) {
            const { agent_type, ...rest } = args ?? {}
            return typeof agent_type === 'string' && (native.isConcurrencySafe?.(rest) ?? false)
          },
          async execute(args, exec) {
            if (args && Object.hasOwn(args, 'preset')) throw new Error('preset is host-owned; select agent_type instead')
            if (!args || typeof args.agent_type !== 'string' || !args.agent_type.trim()) throw new Error('agent_type is required')
            const types = await readTypes()
            const type = types.find(entry => entry.id === args.agent_type)
            if (!type) throw new Error(`Unknown agent_type ${JSON.stringify(args.agent_type)}. Available: ${types.map(entry => entry.id).join(', ')}`)
            const agentOptions = optionsFor(type)
            if (agentOptions && !ctx.subagents.getProvider(provider)?.capabilities.agentOptions) throw new Error(`subagent provider "${provider}" does not support child agentOptions`)
            const { agent_type, ...rest } = args
            // Native execute retains argument validation, route/effort preflight,
            // cancellation, depth enforcement, durable child IDs, and disposal.
            return withPreset(ctx, presetBridge, type.preset, exec.agent, () => selection.run({ agentOptions }, () => native.execute(rest, exec)))
          },
        })
      },
    })
    applyNative(facade(ctx, { tools }), {
      provider,
      toolName,
      backgroundMode: 'continuable',
      enableRunInBackground: true,
      modelSelectionSettings: false,
      maxDepth: config.maxDepth ?? 3,
      // Only the route is configured here. `persona` is deliberately not wired:
      // the child's startup instruction is the caller's `prompt` argument alone.
      get agentOptions() { return selection.getStore()?.agentOptions },
    })
  }
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    const visible = assembly.tools.filter(tool => tool.name === 'subagent' || tool.name === 'subagent_fork')
    if (!visible.length) return assembly
    const types = await readTypes()
    const names = types.map(type => type.id)
    for (const tool of visible) {
      if (tool.parameters.properties?.agent_type) tool.parameters.properties.agent_type.enum = names
    }
    const text = [
      '## Agent types',
      'Every subagent/subagent_fork call requires agent_type. Choose explorer for investigation, worker for implementation, reviewer for independent review; choose a custom type when its description better fits. Use subagent for self-contained work and subagent_fork when completed conversation context is needed.',
      'A type is a delegation profile, not a role prompt: it selects the child LLM route and its native preset tool composition, and its description is the only text published here. It carries no instructions of its own, so the `prompt` argument is the child\'s complete startup instruction — write it self-contained, stating the goal, the relevant context, and every constraint the child must respect (including whether it may modify files). Nothing is implied by the type name.',
      'Types do not grant permissions or sandbox authority: the child inherits the delegation scope fixed at start and cannot widen it. An omitted preset inherits the parent composition. Omitted model/provider/effort settings inherit compatible parent values; a changed route uses its model default effort unless explicitly configured.',
      ...types.map(type => `- ${type.id} (${type.name}): ${type.description} Preset: ${type.preset ?? 'inherit parent preset'}.`),
    ].join('\n')
    return { ...assembly, sections: [...assembly.sections.filter(section => section.name !== 'codex:agent-types'), { name: 'codex:agent-types', text }] }
  })
}
