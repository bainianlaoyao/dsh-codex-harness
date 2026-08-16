/**
 * Mount-shape check for the codex preset's local tool rows: resolves each
 * module specifier the way the loader does (`new URL(name, baseUrl)` with
 * baseUrl = this composition's directory, keeping the ?v= cache query) and
 * asserts the plugin contract {name, inject, apply}.
 *
 * Usage: node check-rows.mjs  (from the preset directory)
 */
import assert from 'node:assert/strict'

const baseUrl = new URL('./', import.meta.url)
const rows = [
  '../../plugins/tools/exec-command.js?v=7',
  '../../plugins/tools/apply-patch.js?v=3',
  '../../plugins/tools/update-plan.js?v=1',
  '../../plugins/tools/view-image.js?v=1',
  '../../plugins/tools/request-user-input.js?v=1',
  '../../plugins/tools/multi-agent.js?v=3',
  '../../plugins/tools/restrict.js?v=1',
  '../../plugins/tools/prompt-align.js?v=2',
  '../../plugins/harness/codex-compactor.js?v=1',
]

for (const specifier of rows) {
  const resolved = new URL(specifier, baseUrl).href
  const mod = await import(resolved)
  assert.equal(typeof mod.apply, 'function', `${specifier}: apply is a function`)
  assert.equal(typeof mod.name, 'string', `${specifier}: name exported`)
  assert.ok(Array.isArray(mod.inject), `${specifier}: inject exported`)
  console.log(`OK ${mod.name} ← ${resolved}`)
}
console.log('preset rows check: ALL PASS')
