import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const source = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')
let registration, component, slotOptions, cursor = 0, started = false
let contextPanel, contextDefinition, contextDivider, registeredTab, openerRegistration, panelRegistration
const hooks = [], effects = [], calls = [], slotRegistrations = [], openedTabs = [], loadThroughCalls = [], scrolled = []
let conflict = false
let contextResponse = {
  enabled: true,
  windowId: 'window-2',
  windows: [
    { id: 'window-1', kind: 'note-reset', seq: 3, dividerSeq: 4, dividerId: 'compaction-1', time: 1000 },
    { id: 'window-2', kind: 'fallback', seq: 11, dividerSeq: 12, dividerId: 'compaction-2', time: 2000, reason: 'No current-window Note.' },
  ],
  note: { revision: 3, windowId: 'window-2', read: false, content: '<script>not markup</script>\nhandoff' },
  budget: { estimatedUsed: 300, estimatedRemaining: 700, capacity: 1000, modelRemaining: 640, modelCapacity: 1000, modelUpdatedAt: 3000 },
}
const enabledContextResponse = contextResponse
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
react.Fragment = 'fragment'
const contextAnchor = id => `${'codex-context-divider'.length}:codex-context-divider${id}`
const chatRow = { dataset: { chatAnchorKey: contextAnchor('compaction-2') }, hidden: false, scrollIntoView: options => scrolled.push(options) }
const document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [chatRow],
}
const slots = {
  inject(_name, factory) { return factory() },
  register(options, value) {
    const entry = { options, component: value }
    slotRegistrations.push(entry)
    if (options.id === 'codex-agent-types') { slotOptions = options; component = value }
    if (options.id === 'codex-context-opener') openerRegistration = entry
    if (options.key === 'codex-context') { panelRegistration = entry; contextPanel = value }
    if (options.key === 'codex-context-divider') contextDivider = value
    return () => {}
  },
}
const sessions = {
  binding(id) {
    if (id !== 's1') return undefined
    return { session: { loadThrough: async seq => { loadThroughCalls.push(seq) } } }
  },
}
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: value => { registration = value } } },
  document,
  AbortController,
  URLSearchParams,
  setTimeout,
  requestAnimationFrame: callback => callback(),
  fetch: async (url, options = {}) => {
    calls.push({ url, options })
    if (url.startsWith('/api/codex-context.state')) {
      if (options.method === 'HEAD') return { ok: contextResponse.enabled, status: contextResponse.enabled ? 204 : 404 }
      return { ok: true, status: 200, json: async () => contextResponse }
    }
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
assert.deepEqual(Array.from(plugin.inject), ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'uiConversation'])
plugin.apply({
  get: () => slots,
  effect: fn => fn(),
  sidebarRightTabs: { register: value => { registeredTab = value; return () => {} } },
  sidebarRight: { openTab: kind => openedTabs.push(kind) },
  sessions,
  uiConversation: { events: { register: value => { contextDefinition = value; return () => {} } } },
})
assert.equal(slotOptions.id, 'codex-agent-types')
assert.equal(registeredTab.kind, 'codex-context')
assert.equal(registeredTab.title(), '上下文')
assert.equal(contextDefinition.kind, 'codex-context-divider')
assert.equal(contextDefinition.target, 'chat')
assert.ok(slotRegistrations.some(row => row.options.name === 'conversation.chat.node' && row.options.key === 'codex-context-divider'))
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

const treeWalk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(treeWalk)]
const treeText = node => !node || typeof node !== 'object' ? String(node ?? '') : (node.children || []).map(treeText).join(' ')
const presetValues = { agentPreset: 'codex' }
const openerProps = openerRegistration.options.inject('s1')
hooks.length = 0; effects.length = 0; cursor = 0; started = false
let openerTree = openerRegistration.component({ ...openerProps, sessionId: 's1', useProjection: key => presetValues[key] })
assert.equal(openerTree, null, 'header opener stays hidden until the mode-only HEAD probe resolves')
started = true
effects.splice(0).forEach(fn => fn())
await flush()
cursor = 0
openerTree = openerRegistration.component({ ...openerProps, sessionId: 's1', useProjection: key => presetValues[key] })
const openerButton = treeWalk(openerTree).find(node => node.tag === 'button')
assert.ok(openerButton, '204 mode probe reveals the codex session opener')
assert.ok(calls.some(call => call.url === '/api/codex-context.state?sessionId=s1' && call.options.method === 'HEAD'))
assert.ok(!calls.some(call => call.url.startsWith('/api/codex-context.state') && call.options.method === 'GET'),
  'the HEAD probe does not fetch the Note')
await openerButton.props.onClick()
assert.deepEqual(openedTabs, ['codex-context'], 'header opener opens the right sidebar context tab')
assert.ok(calls.some(call => call.url === '/api/codex-context.state?sessionId=s1' && call.options.method === 'GET'),
  'the full context state is fetched only after the opener click')
cursor = 0
assert.equal(openerRegistration.component({ ...openerProps, sessionId: 's1', useProjection: () => 'codex-creative' }), null,
  'other presets do not get the opener')

contextResponse = { ...enabledContextResponse, enabled: false }
hooks.length = 0; effects.length = 0; cursor = 0; started = false
assert.equal(openerRegistration.component({ ...openerProps, sessionId: 'legacy-codex', useProjection: () => 'codex' }), null)
started = true
effects.splice(0).forEach(fn => fn())
await flush()
cursor = 0
assert.equal(openerRegistration.component({ ...openerProps, sessionId: 'legacy-codex', useProjection: () => 'codex' }), null,
  'legacy codex session stays without the opener after an authenticated 404')
assert.ok(calls.some(call => call.url === '/api/codex-context.state?sessionId=legacy-codex' && call.options.method === 'HEAD'))
assert.ok(!calls.some(call => call.url.endsWith('sessionId=legacy-codex') && call.options.method === 'GET'),
  'legacy session probe never downloads Note state')
contextResponse = enabledContextResponse

const compactionEvent = { type: 'compaction/summary', data: { compactionId: 'compaction-2', windowId: 'window-2', summary: [{ type: 'text', text: '[codex-context-summary-fallback:v1] No Note' }] }, seq: 12, time: 2000 }
const matched = contextDefinition.match(compactionEvent)
assert.equal(matched.role, 'start')
const startMatch = { event: compactionEvent, role: 'start', location: { kind: 'unresolved' } }
const markerState = contextDefinition.start({}, startMatch, {})
const markerNode = contextDefinition.buildViewNode({ key: contextAnchor('compaction-2'), id: 'compaction-2', start: startMatch, state: markerState })
assert.equal(markerNode.kind, 'codex-context-divider')
assert.equal(markerNode.anchorSeq, 12)
assert.equal(treeText(contextDivider({ node: markerNode })).includes('普通摘要兜底'), true)
assert.equal(contextDefinition.match({ ...compactionEvent, data: { ...compactionEvent.data, summary: [{ type: 'text', text: 'ordinary native compaction' }] } }), null,
  'native summaries without the reserved prefix do not get a Codex marker')

const injectedPanel = panelRegistration.options.inject('s1', {})
const tabSignal = new AbortController().signal
const panelProps = {
  ...injectedPanel,
  sessionId: 's1',
  useProjection: key => presetValues[key],
  useTabInfo: () => ({ tab: { signal: tabSignal } }),
}
hooks.length = 0; effects.length = 0; cursor = 0; started = false
let panelTree = contextPanel(panelProps)
assert.ok(treeText(panelTree).includes('正在读取'), 'panel begins in a loading state')
started = true
effects.splice(0).forEach(fn => fn())
await flush()
cursor = 0
panelTree = contextPanel(panelProps)
const panelNodes = treeWalk(panelTree)
const panelText = treeText(panelTree)
assert.ok(panelText.includes('Note（只读）'))
assert.ok(panelText.includes('本地使用估算') && panelText.includes('模型工具最近查询（同为估算）'))
assert.ok(panelText.includes('300 tokens') && panelText.includes('700 tokens') && panelText.includes('640 tokens'))
assert.ok(panelText.includes('<script>not markup</script>'), 'Note is rendered as escaped text, never parsed as HTML')
assert.equal(panelNodes.some(node => node.tag === 'script' || node.tag === 'textarea' || node.tag === 'input'), false,
  'Note is read-only and untrusted HTML is not interpreted')
const contextFetch = calls.find(call => call.url.startsWith('/api/codex-context.state') && call.options.method === 'GET')
assert.equal(contextFetch.url, '/api/codex-context.state?sessionId=s1')
assert.equal(contextFetch.options.credentials, 'same-origin')
assert.equal(contextFetch.options.cache, 'no-store')
assert.equal(contextFetch.options.method, 'GET')
const jumpButton = panelNodes.find(node => node.tag === 'button' && String(node.children[0]).includes('普通摘要兜底'))
assert.ok(jumpButton, 'timeline includes fallback window node')
await jumpButton.props.onClick()
assert.deepEqual(loadThroughCalls, [12], 'timeline jump loads history through dividerSeq in the same session')
assert.equal(scrolled.length, 1, 'timeline jump scrolls to the in-Chat divider anchor')
assert.equal(contextFetch, calls.find(call => call.url.startsWith('/api/codex-context.state') && call.options.method === 'GET'),
  'opening from the header fetches the authorized full state once; panel consumes the one-shot result')

contextResponse = { enabled: false, note: { content: 'must not render' } }
hooks.length = 0; effects.length = 0; cursor = 0; started = false
contextPanel(panelProps)
started = true
effects.splice(0).forEach(fn => fn())
await flush()
cursor = 0
panelTree = contextPanel(panelProps)
assert.ok(treeText(panelTree).includes('未启用 Codex 单窗口上下文'))
assert.ok(!treeText(panelTree).includes('must not render'), 'disabled backend response fails closed without exposing a Note')

console.log('client smoke: settings, codex-only opener, authenticated on-demand context, read-only Note, separate budgets, Chat markers and timeline jump passed')
