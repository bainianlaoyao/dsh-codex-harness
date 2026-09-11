// Real Chromium + React DOM + the original client bundle + the real Cordis Host
// service/settings CAS. HTTP is bridged by Playwright routing; no server starts.
// Optional: DSH_E2E_DEPS=/path/to/node_modules, DSH_E2E_CHROMIUM=/path/to/chrome.
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as plugin from '../plugins/agent-types.js'

const cache = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'npm-cache/_npx')
const roots = [process.env.DSH_E2E_DEPS, path.resolve('node_modules'),
  ...(existsSync(cache) ? readdirSync(cache).map(name => path.join(cache, name, 'node_modules')) : [])].filter(Boolean)
function dependency(relative) {
  const result = roots.map(root => path.join(root, relative)).find(file => existsSync(file))
  if (!result) throw new Error(`Missing ${relative}; install test dependencies in a separate directory and set DSH_E2E_DEPS (never install into the repository junction).`)
  return result
}
const { chromium } = await import(pathToFileURL(dependency('playwright/index.mjs')).href)
// React and ReactDOM must come from the same dependency root/version pair.
const reactRoot = roots.find(root => existsSync(path.join(root, 'react/umd/react.development.js')) && existsSync(path.join(root, 'react-dom/umd/react-dom.development.js')))
if (!reactRoot) throw new Error('React 18 UMD + ReactDOM 18 UMD required; set DSH_E2E_DEPS to their separate node_modules directory.')
const browserCache = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'ms-playwright')
const installedChrome = existsSync(browserCache) ? readdirSync(browserCache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(name => path.join(browserCache, name, 'chrome-win64/chrome.exe')).find(file => existsSync(file)) : undefined

let stored = {}
class MemorySettings extends SettingsProvider {
  writable = true
  async load() { return structuredClone(stored) }
  async persist(ns, section) { stored[ns] = structuredClone(section) }
}
class Models extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  listProviders() { return [{ id: 'native', name: 'Native' }, { id: 'offline', name: 'Offline' }] }
  async listModels(provider) {
    if (provider === 'offline') throw new Error('offline provider')
    return [{ provider, id: 'model', name: 'Native model' }]
  }
  async resolveModelInfo(provider, id) {
    return { provider, id, name: 'Native model', reasoning: { efforts: [{ id: 'max', name: 'Maximum' }], defaultEffort: 'max' } }
  }
}
class Routes extends Service {
  constructor(ctx) { super(ctx, 'webServer') }
  register() { return () => {} }
}
let presetUnavailable = false
const presetRows = [{ id: 'code', name: 'Code' }, { id: 'creative', name: 'Creative' }, { id: 'broken', name: 'Broken', broken: 'Invalid composition' }]
class Presets extends Service {
  constructor(ctx) { super(ctx, 'agentPresets') }
  list() {
    if (presetUnavailable) throw new Error('preset directory offline')
    return structuredClone(presetRows)
  }
  resolve(id) {
    const row = this.list().find(row => row.id === id)
    if (!row) throw new Error(`Unknown preset: ${id}`)
    return row
  }
}
const ctx = new Context()
let browser
try {
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Models)
  await ctx.plugin(Routes)
  await ctx.plugin(Presets)
  await ctx.plugin(plugin)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.codexAgentTypes)
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_E2E_CHROMIUM || installedChrome })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://codex-test.local/**', async route => {
    const incoming = route.request()
    const url = new URL(incoming.url())
    if (!url.pathname.startsWith('/codex-agent-types/api/')) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
      return
    }
    const req = Readable.from(incoming.postData() ? [incoming.postData()] : [])
    req.method = incoming.method()
    req.headers = { ...await incoming.allHeaders(), host: url.host }
    const headers = {}
    const res = { status: 200, setHeader(name, value) { headers[name] = String(value) }, writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await ctx.codexAgentTypes.handle(url.pathname.split('/').at(-1), req, res)
    await route.fulfill({ status: res.status, headers, body: res.body })
  })
  await page.goto('http://codex-test.local/')
  await page.addScriptTag({ path: path.join(reactRoot, 'react/umd/react.development.js') })
  await page.addScriptTag({ path: path.join(reactRoot, 'react-dom/umd/react-dom.development.js') })
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(registration) {
      const plugin = registration.factory(id => { if (id === 'react') return window.React; throw new Error(`Unexpected module ${id}`) })
      const slots = { inject(name, fn) { fn() }, register(options, Component) {
        if (options.name !== 'settings.section') throw new Error('Wrong slot')
        window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(Component))
        return () => {}
      } }
      plugin.apply({ get: () => slots, effect: fn => fn() })
    } }
  })
  await page.addScriptTag({ content: await readFile(new URL('../plugins/client.js', import.meta.url), 'utf8') })
  await page.getByRole('heading', { name: 'Codex 子代理' }).waitFor()
  await page.locator('section').nth(2).waitFor()
  assert.equal(await page.locator('section').count(), 3)
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).count(), 0)
  await page.getByText('部分 provider / model 目录加载失败', { exact: false }).waitFor()
  await page.getByRole('button', { name: '新增类型', exact: true }).click()
  const custom = page.locator('section').nth(3)
  const presetSelect = () => custom.locator('label').filter({ has: page.locator('span', { hasText: /^Preset$/ }) }).locator('select')
  await custom.getByLabel('类型 ID', { exact: true }).fill('browser-test')
  await custom.getByLabel('显示名', { exact: true }).fill('Browser Agent')
  await custom.getByLabel('描述（供主代理选择类型）', { exact: true }).fill('Browser lifecycle test')
  assert.equal(await custom.getByLabel('Instructions（子代理指令）', { exact: true }).count(), 0, 'types expose no instruction field')
  assert.equal(await presetSelect().locator('option[value="broken"]').evaluate(option => option.disabled), true)
  await presetSelect().selectOption('code')
  await custom.locator('label').filter({ has: page.locator('span', { hasText: /^Provider$/ }) }).locator('select').selectOption('native')
  await custom.locator('label').filter({ has: page.locator('span', { hasText: /^Model$/ }) }).locator('select').selectOption('model')
  await custom.locator('label').filter({ has: page.locator('span', { hasText: /^Reasoning effort$/ }) }).locator('select').selectOption('max')
  const save = () => page.getByRole('button', { name: '保存 *', exact: true }).click()
  await save()
  await page.getByText('已保存。当前运行请求', { exact: false }).waitFor()
  assert.equal(ctx.codexAgentTypes.list().at(-1).reasoningEffort, 'max')
  assert.equal(ctx.codexAgentTypes.list().at(-1).id, 'browser-test')
  assert.equal(ctx.codexAgentTypes.list().at(-1).preset, 'code')
  assert.equal(Object.hasOwn(ctx.codexAgentTypes.list().at(-1), 'instructions'), false, 'no role text is ever persisted')
  assert.equal(Object.keys(stored).length, 1, 'real SettingsProvider persists')
  if (process.env.DSH_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.DSH_E2E_SCREENSHOT, fullPage: true })
    console.log(`Browser screenshot: ${process.env.DSH_E2E_SCREENSHOT}`)
  }
  await custom.getByLabel('显示名', { exact: true }).fill('Edited Browser Agent')
  await save()
  await page.waitForFunction(() => document.querySelector('.cam-actions button')?.disabled)
  assert.equal(ctx.codexAgentTypes.list().at(-1).name, 'Edited Browser Agent')
  await presetSelect().selectOption('creative')
  await save()
  await page.waitForFunction(() => document.querySelector('.cam-actions button')?.disabled)
  assert.equal(ctx.codexAgentTypes.list().at(-1).preset, 'creative')
  // A failed live catalog read must not erase the user's configuration.
  presetUnavailable = true
  await page.getByRole('button', { name: '刷新 Preset 目录', exact: true }).click()
  await page.getByText('Preset 目录加载失败', { exact: false }).waitFor()
  assert.equal(await presetSelect().inputValue(), 'creative')
  presetUnavailable = false
  presetRows.push({ id: 'new-preset', name: 'New Preset' })
  await page.getByRole('button', { name: '刷新 Preset 目录', exact: true }).click()
  await presetSelect().locator('option[value="new-preset"]').waitFor({ state: 'attached' })
  // Deleted/unknown presets remain visible, but real Host validation rejects saving.
  presetRows.splice(presetRows.findIndex(row => row.id === 'creative'), 1)
  await page.getByRole('button', { name: '刷新 Preset 目录', exact: true }).click()
  await presetSelect().locator('option[value="creative"]').filter({ hasText: '目录暂不可用' }).waitFor({ state: 'attached' })
  await custom.getByLabel('显示名', { exact: true }).fill('Unknown preset draft')
  await save()
  await page.getByText('保存失败（本地编辑已保留）', { exact: false }).waitFor()
  assert.equal(await presetSelect().inputValue(), 'creative')
  await presetSelect().selectOption('')
  await save()
  await page.waitForFunction(() => document.querySelector('.cam-actions button')?.disabled)
  assert.equal(Object.hasOwn(ctx.codexAgentTypes.list().at(-1), 'preset'), false, 'empty preset inherits parent')
  // Even if a request bypasses the disabled option, the real service must reject it.
  await assert.rejects(ctx.codexAgentTypes.replace({ revision: ctx.codexAgentTypes.current().revision, types: ctx.codexAgentTypes.list().map(row => row.id === 'browser-test' ? { ...row, preset: 'broken' } : row) }))
  // A competing real settings write invalidates the client's revision.
  await ctx.codexAgentTypes.replace({ revision: ctx.codexAgentTypes.current().revision, types: ctx.codexAgentTypes.list().map(row => row.id === 'browser-test' ? { ...row, name: 'Concurrent edit' } : row) })
  await custom.getByLabel('显示名', { exact: true }).fill('Unsaved browser draft')
  await save()
  await page.getByText('保存冲突：', { exact: false }).waitFor()
  assert.equal(await custom.getByLabel('显示名', { exact: true }).inputValue(), 'Unsaved browser draft')
  assert.equal(ctx.codexAgentTypes.list().at(-1).name, 'Concurrent edit')
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByRole('button', { name: '确认放弃编辑并重新加载', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(node => node.value === 'Concurrent edit'))
  await custom.getByRole('button', { name: '删除', exact: true }).click()
  await custom.getByRole('button', { name: '确认删除', exact: true }).click()
  await save()
  await page.waitForFunction(() => document.querySelector('.cam-actions button')?.disabled)
  assert.equal(ctx.codexAgentTypes.list().length, 3)
  assert.equal(await page.locator('section').count(), 3)
  assert.deepEqual(errors, [])
  console.log('agent-types browser E2E: PASS (real Chromium/React/Cordis SettingsProvider; create/save/edit/native effort/preset inheritance+refresh+validation/delete/CAS; no server started)')
} finally {
  await browser?.close()
  await ctx.fiber.dispose()
}
