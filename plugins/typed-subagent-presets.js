/** Execution-only bridge for native runtimes without a subagent preset request field.
 * No preset emulation: native factory setup and AgentPresets.mount/composeFrom own all
 * composition, rollback and lifetime. The shared registry shim preserves its
 * Cordis receiver and is restored when the last adapter scope is disposed.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'

const selection = new AsyncLocalStorage()
const installations = new WeakMap()

// Install this row on the Host plane as well: cold continuation can originate
// from a parent preset which does not itself contain typed delegation tools.
export const name = 'codex-typed-subagent-presets'
export const inject = ['agents', 'agentPresets']
export function apply(ctx) { installPresetBridge(ctx) }

function facade(target, overrides) {
  return new Proxy(target, { get(object, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key]
    const value = Reflect.get(object, key, object)
    return typeof value === 'function' ? value.bind(object) : value
  } })
}

async function composeSetup(ownerCtx, original, receiver, options, method, preset) {
  let donor, preparing
  try {
    return await original.call(receiver, {
      ...options,
      ...(preset === undefined ? {} : { meta: { ...options.meta, agentPreset: preset } }),
      async setup(childCtx, child) {
        // The inherited fork prefix cannot select this child's composition.
        const saved = method === 'resume'
          ? child.session.snapshotEvents(child.session.inheritedEventCount).filter(event => event.type === 'agent-preset/selected').at(-1)?.data.agentPreset
          : preset
        if (saved === undefined) return options.setup?.(childCtx, child)
        const presets = childCtx.get('agentPresets')
        if (!presets?.mount || !presets?.composeFrom) throw new Error('typed subagents: native agentPresets is unavailable')
        if (typeof options.setup !== 'function' || options.setup.constructor.name === 'AsyncFunction') throw new Error('typed subagents: native synchronous child setup is required')
        // Mount ONLY a temporary donor while awaiting I/O. Native raceAbort may
        // dispose the child at any await; no child mutation occurs until the
        // factory invokes this synchronous commit, immediately before publication.
        donor = createScope(ownerCtx, {})
        preparing = presets.mount(donor.ctx, saved)
        await preparing
        return { commit() {
          let joined = false
          const nativePresets = facade(presets, {
            composeFrom(targetCtx) { joined = true; return presets.composeFrom(targetCtx, donor.ctx) },
          })
          const setupCtx = facade(childCtx, {
            get(key, ...args) { return key === 'agentPresets' ? nativePresets : childCtx.get(key, ...args) },
          })
          const finalizer = options.setup?.(setupCtx, child)
          if (finalizer?.then) throw new Error('typed subagents: native synchronous child setup is required')
          if (!joined) throw new Error('typed subagents: native child setup did not compose its preset')
          finalizer?.commit()
          if (method === 'create') child.session.append('agent-preset/selected', { agentPreset: saved })
        } }
      },
    })
  } finally {
    // A canceled native setup may still be mounting its donor. Drain it before
    // disposal, but never run its abandoned commit or touch the disposed child.
    await preparing?.catch(() => {})
    await donor?.dispose()
  }
}

export function installPresetBridge(ctx) {
  const service = ctx.get('agents')
  if (!service) return false
  const registry = service[symbols.original] ?? service
  let installed = installations.get(registry)
  if (!installed) {
    const descriptors = new Map()
    const wrappers = new Map()
    for (const method of ['create', 'resume']) {
      const original = registry[method]
      if (typeof original !== 'function') throw new Error(`typed subagents: agents.${method} is unavailable`)
      const descriptor = Object.getOwnPropertyDescriptor(registry, method)
      if (descriptor && !descriptor.configurable) throw new Error(`typed subagents: agents.${method} cannot be adapted`)
      descriptors.set(method, descriptor)
      const wrapper = function (options) {
        const active = selection.getStore()
        const preset = method === 'create' && !active?.claimed && active?.parent === options.parentAgent && options.meta?.origin === 'subagent' ? active?.preset : undefined
        if (preset !== undefined) active.claimed = true
        if (preset === undefined && (method !== 'resume' || !options.parentAgent)) return original.call(this, options)
        return composeSetup(this.ctx ?? ctx, original, this, options, method, preset)
      }
      wrappers.set(method, wrapper)
    }
    try {
      for (const [method, wrapper] of wrappers) Object.defineProperty(registry, method, { configurable: true, writable: true, value: wrapper })
    } catch (error) {
      for (const [method, descriptor] of descriptors) {
        if (registry[method] !== wrappers.get(method)) continue
        if (descriptor) Object.defineProperty(registry, method, descriptor)
        else delete registry[method]
      }
      throw error
    }
    installed = { users: 0, descriptors, wrappers }
    installations.set(registry, installed)
  }
  installed.users++
  ctx.effect(() => () => {
    if (--installed.users) return
    for (const [method, descriptor] of installed.descriptors) {
      if (registry[method] !== installed.wrappers.get(method)) continue
      if (descriptor) Object.defineProperty(registry, method, descriptor)
      else delete registry[method]
    }
    installations.delete(registry)
  })
  return true
}

export async function withPreset(ctx, available, preset, parent, run) {
  if (preset === undefined) return selection.run(undefined, run)
  if (!available) throw new Error('typed subagents: native child creation bridge is unavailable')
  const presets = ctx.get('agentPresets')
  if (!presets?.resolve || !presets?.mount || !presets?.composeFrom) throw new Error('typed subagents: native agentPresets is unavailable')
  const resolved = await presets.resolve(preset)
  if (resolved.broken !== undefined) throw new Error(`typed subagents: preset ${preset} is broken: ${JSON.stringify(resolved.broken)}`)
  return selection.run({ preset, parent }, run)
}
