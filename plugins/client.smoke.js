import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const source = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')
let registration, component, slotOptions, cursor = 0, started = false
const hooks = [], effects = [], calls = []
let conflict = false
const state = { revision: 'r1', types: [
  { id: 'explorer', name: 'Explorer', description: 'Explore' },
  { id: 'worker', name: 'Worker', description: 'Implement' },
  { id: 'reviewer', name: 'Reviewer', description: 'Review' },
] }
const react = {
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
  useState(initial) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = initial
    return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
  },
  useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial } },
  useEffect(fn) { if (!started) effects.push(fn) },
}
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: value => { registration = value } } },
  fetch: async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/presets')) return { ok: true, json: async () => ({ presets: [
      { id: 'code', name: 'Code' }, { id: 'broken', name: 'Broken', broken: 'Invalid composition' },
    ] }) }
    if (url.endsWith('/models')) return { ok: true, json: async () => ({
      providers: [{ id: 'p', name: 'Provider' }, { id: 'failed', name: 'Failed' }],
      models: [{ provider: 'p', id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
      failures: [{ provider: 'failed', error: 'offline' }],
    }) }
    if (options.method === 'PUT') {
      if (conflict) return { ok: false, status: 409, json: async () => ({ error: 'revision conflict', current: state }) }
      return { ok: true, json: async () => ({ ...JSON.parse(options.body), revision: 'r2' }) }
    }
    return { ok: true, json: async () => structuredClone(state) }
  },
})
assert.equal(registration.id, 'dsh-codex-mode')
const plugin = registration.factory(id => { assert.equal(id, 'react'); return react })
assert.deepEqual(Array.from(plugin.inject), ['slots'])
plugin.apply({
  get: () => ({ inject: (name, fn) => { assert.equal(name, 'settings.section'); fn() }, register: (options, value) => { slotOptions = options; component = value } }),
  effect: () => {},
})
assert.equal(slotOptions.id, 'codex-agent-types')
const render = () => { cursor = 0; return component() }
const walk = node => typeof node !== 'object' ? [] : [node, ...node.children.flatMap(walk)]
const all = tag => walk(render()).filter(node => node.tag === tag)
const button = label => all('button').find(node => node.children.includes(label))
const flush = () => new Promise(resolve => setImmediate(resolve))
render(); started = true; effects.forEach(fn => fn()); await flush()
assert.equal(all('section').length, 3)
assert.equal(button('删除'), undefined, 'builtins cannot be deleted')
assert.ok(walk(render()).some(node => node.props.role === 'status' && String(node.children).includes('目录加载失败')))

button('新增类型').props.onClick()
assert.equal(all('section').length, 4)
await button('保存 *').props.onClick()
assert.ok(!calls.some(call => call.options.method === 'PUT'), 'empty description blocked')
all('textarea').at(-1).props.onChange({ target: { value: 'Custom description' } })
assert.ok(all('select').at(-4).children.find(option => option.props.value === 'broken').props.disabled)
all('select').at(-4).props.onChange({ target: { value: 'code' } })
const provider = all('select').at(-3)
provider.props.onChange({ target: { value: 'p' } })
all('select').at(-2).props.onChange({ target: { value: 'm' } })
assert.ok(all('select').at(-1).children.some(option => option.props.value === 'high'))
all('select').at(-1).props.onChange({ target: { value: 'high' } })
conflict = true
await button('保存 *').props.onClick()
assert.equal(all('section').length, 4, 'CAS conflict retains draft')
assert.ok(walk(render()).some(node => String(node.children).includes('本地编辑已保留')))
conflict = false
await button('保存 *').props.onClick()
const saved = JSON.parse(calls.filter(call => call.options.method === 'PUT').at(-1).options.body)
assert.equal(saved.revision, 'r1', 'conflict does not silently adopt revision')
assert.equal(saved.types.at(-1).reasoningEffort, 'high')
assert.equal(saved.types.at(-1).provider, 'p')
assert.equal(saved.types.at(-1).preset, 'code')
assert.equal(Object.hasOwn(saved.types.at(-1), 'instructions'), false, 'no role text is ever sent')
assert.ok(button('保存').props.disabled)
all('select').at(-4).props.onChange({ target: { value: '' } })
await button('保存 *').props.onClick()
assert.ok(!Object.hasOwn(JSON.parse(calls.filter(call => call.options.method === 'PUT').at(-1).options.body).types.at(-1), 'preset'))
assert.ok(!source.includes('selectModel('), 'never changes session/default model')
button('删除').props.onClick(); button('确认删除').props.onClick()
assert.equal(all('section').length, 3)
console.log('client smoke: registration, builtin protection, validation, native effort, CAS preservation, save/delete passed')
