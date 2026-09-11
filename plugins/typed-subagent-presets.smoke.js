// Native roster/Loader composition and scope routing; only Agent creation is mocked.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { applyChildComposition } from '@deepseek-ai/dsh-subagent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installPresetBridge, withPreset } from './typed-subagent-presets.js'

const directory = await mkdtemp(join(tmpdir(), 'typed-presets-smoke-'))
const root = new Context()
const scopes = []
const scoped = () => {
  const key = {}
  const scope = createScope(root, key)
  scopes.push(scope)
  return { key, ctx: scope.ctx, dispose: () => scope.dispose() }
}
try {
  // Tiny real plugin rows avoid shell/LLM dependencies while exercising the
  // same include tree, standing mounts and reparenting as production presets.
  const plugin = join(directory, 'tool.mjs')
  await writeFile(plugin, `export const inject = ['tools', 'systemPrompt'];
export async function apply(ctx, config) {
  if (config.tool === 'slow_only') await ctx.get('smokeGate').wait();
  ctx.tools.register({ name: config.tool, description: config.tool,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'array', items: {} }, render: value => value },
    async execute() { return [] } });
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: config.tool });
}`)
  for (const id of ['parent', 'reader', 'writer', 'slow']) {
    const path = join(directory, id)
    await mkdir(path)
    await writeFile(join(path, 'preset.yml'), `name: ${id}\ndescription: smoke ${id}\n`)
    await writeFile(join(path, 'agent.cordis.yml'), JSON.stringify([
      { id: 'tool', name: pathToFileURL(plugin).href, config: { tool: `${id}_only` } },
    ]))
  }
  new Loader(root, { baseUrl: import.meta.url })
  root.baseUrl = import.meta.url
  new SystemPrompt(root, {})
  new ToolRuntime(root)
  new SessionProjections(root)
  new AgentPresets(root, {
    default: 'parent', roots: [{ path: directory, trust: 'system' }],
    includeShippedRoot: false, includeUserRoot: false,
  })
  const parent = scoped()
  await root.agentPresets.mount(parent.ctx, 'parent')
  const names = child => root.tools.schemas(child.key).map(tool => tool.name).sort()
  assert.deepEqual(names(parent), ['parent_only'])
  assert.deepEqual(root.tools.schemas(), [], 'standing tools never become global')

  let commits = 0
  const finalizer = { commit() { commits++ } }
  let calls = 0
  const nativeRegistry = new AgentRegistry(root)
  const registry = root.agents
  const factory = {
    async createAgent(ownerCtx, options) {
      assert.ok(ownerCtx.root === root, 'native registry preserves the caller Cordis root')
      calls++
      const child = { ...scoped(), meta: options.meta }
      const events = structuredClone(options.events ?? [])
      child.session = {
        inheritedEventCount: options.inheritedEventCount ?? 0,
        snapshotEvents: (offset = 0) => events.slice(offset),
        append: (type, data) => events.push({ type, data }),
      }
      const preparing = Promise.resolve(options.setup?.(child.ctx, child))
      if (options.cancelDuringSetup) {
        preparing.catch(() => {})
        await options.cancelDuringSetup(child)
        throw new Error('smoke setup aborted')
      }
      const prepared = await preparing
      const before = commits
      prepared?.commit()
      assert.equal(commits, before + 1, 'native setup commit survives bridge')
      return child
    },
    async resume(ownerCtx, options) { return this.createAgent(ownerCtx, options) },
  }
  registry.setFactory(factory)
  const originalCreate = nativeRegistry.create, originalResume = nativeRegistry.resume
  const adapter = createScope(root, {})
  scopes.push(adapter)
  const available = installPresetBridge(adapter.ctx)
  assert.equal(available, true)
  function options(persona, extra = {}) {
    return {
      parentAgent: parent, meta: { origin: 'subagent', retained: true }, ...extra,
      setup(ctx) {
        applyChildComposition(ctx, parent, { persona })
        return finalizer
      },
    }
  }
  async function check(child, preset, persona) {
    assert.deepEqual(names(child), [`${preset}_only`], 'selected tools replace rather than union parent tools')
    const prompt = await root.systemPrompt.assemble({ scope: child.key })
    assert.equal(prompt.sections.find(section => section.name === 'deployment:persona-prefix')?.text, persona)
    assert.equal(root.agentPresets.composedPreset(child.ctx), preset)
  }
  // Both ALS selections are live before either registry call is allowed through.
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = 0
  const spawn = (preset, persona) => withPreset(adapter.ctx, available, preset, parent, async () => {
    if (++entered === 2) release()
    await gate
    return registry.create(options(persona))
  })
  const [reader, writer] = await Promise.all([spawn('reader', 'Read carefully'), spawn('writer', 'Write carefully')])
  await check(reader, 'reader', 'Read carefully')
  await check(writer, 'writer', 'Write carefully')
  assert.equal(reader.meta.retained, true)
  assert.equal(reader.meta.agentPreset, 'reader')
  assert.deepEqual(reader.session.snapshotEvents(), [{ type: 'agent-preset/selected', data: { agentPreset: 'reader' } }])
  const inheritedChild = await withPreset(adapter.ctx, available, undefined, parent,
    () => registry.create(options('Inherited persona')))
  await check(inheritedChild, 'parent', 'Inherited persona')
  await root.agentPresets.recompose(inheritedChild.ctx, 'writer')
  await check(inheritedChild, 'writer', 'Inherited persona')
  assert.deepEqual(names(parent), ['parent_only'], 'concurrent children do not mutate parent')
  await withPreset(adapter.ctx, available, 'reader', parent, async () => {
    await check(await registry.create(options('Not delegation', { meta: { origin: 'other' } })), 'parent', 'Not delegation')
    await check(await withPreset(adapter.ctx, available, undefined, parent,
      () => registry.create(options('Nested inheritance'))), 'parent', 'Nested inheritance')
    await check(await registry.create(options('Selected once')), 'reader', 'Selected once')
    await check(await registry.create(options('Not selected twice')), 'parent', 'Not selected twice')
  })
  await withPreset(adapter.ctx, available, 'reader', parent, async () => {
    const descendant = await registry.create({
      ...options('Descendant'), parentAgent: writer,
      setup(ctx) { applyChildComposition(ctx, writer, { persona: 'Descendant' }); return finalizer },
    })
    await check(descendant, 'writer', 'Descendant')
    await check(await registry.create(options('Matching parent')), 'reader', 'Matching parent')
  })

  const before = calls
  await assert.rejects(withPreset(adapter.ctx, available, 'missing-preset', parent,
    () => registry.create(options('Never installed'))), /preset/i)
  assert.equal(calls, before, 'invalid selection fails before child creation')
  let asyncSetupRan = false
  await assert.rejects(withPreset(adapter.ctx, available, 'reader', parent,
    () => registry.create({ ...options('Unsupported async'), async setup() { asyncSetupRan = true } })), /synchronous child setup/)
  assert.equal(asyncSetupRan, false, 'known async setup is rejected before invocation')
  await assert.rejects(withPreset(adapter.ctx, available, 'reader', parent,
    () => registry.create({ ...options('Unsupported promise'), setup() { return Promise.resolve() } })), /synchronous child setup/)
  const inherited = { type: 'agent-preset/selected', data: { agentPreset: 'writer' } }
  const own = { type: 'agent-preset/selected', data: { agentPreset: 'reader' } }
  const restored = await registry.resume(options('Restored persona', { events: [inherited, own], inheritedEventCount: 1 }))
  await check(restored, 'reader', 'Restored persona')
  assert.equal(restored.session.snapshotEvents().length, 2, 'resume does not append duplicate selection')
  await check(await registry.resume(options('Fork persona', { events: [inherited], inheritedEventCount: 1 })), 'parent', 'Fork persona')
  // A real Loader row blocks mount while the mock factory follows native
  // raceAbort: dispose the unpublished child and never invoke its late commit.
  let mountEntered, finishMount, cancelled
  const enteredMount = new Promise(resolve => { mountEntered = resolve })
  const delayedMount = new Promise(resolve => { finishMount = resolve })
  root.provide('smokeGate', { wait() { mountEntered(); return delayedMount } })
  const beforeCancel = commits
  await assert.rejects(withPreset(adapter.ctx, available, 'slow', parent,
    () => registry.create(options('Never committed', {
      async cancelDuringSetup(child) {
        cancelled = child
        await enteredMount
        await child.dispose()
        finishMount()
      },
    }))), /smoke setup aborted/)
  assert.equal(commits, beforeCancel, 'aborted setup cannot commit after mount drains')
  assert.deepEqual(names(cancelled), [], 'late mount cannot bind disposed child')
  assert.deepEqual(cancelled.session.snapshotEvents(), [], 'aborted setup records no selection')
  await adapter.dispose()
  assert.equal(nativeRegistry.create, originalCreate)
  assert.equal(nativeRegistry.resume, originalResume)
  console.log('typed-subagent-presets smoke: ALL PASS (native mounts/composition, tools, persona, concurrency, resume, cancellation, cleanup)')
} finally {
  for (const scope of scopes.reverse()) await scope.dispose()
  await root.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
