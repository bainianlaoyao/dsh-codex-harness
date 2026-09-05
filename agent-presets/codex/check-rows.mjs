/**
 * Mount-shape check for the codex preset's local tool rows.
 *
 * Tool rows now use package exports (`dsh-codex-mode/plugins/tools/...`) so a
 * copy published into `$DSH_HOME/.agent-presets/codex` still resolves against
 * the installed plugin, not a sibling relative path. This check imports the
 * same files from the repo (the package may not be installed in node_modules
 * during `npm test`) and asserts the composition names those exports.
 *
 * Also asserts the composition carries the DSH-native compaction group. The
 * web surface disables host-plane compaction, so a preset without this group
 * never registers `/compact`.
 *
 * Usage: node check-rows.mjs  (from the preset directory)
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const presetDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(presetDir, '..', '..')
const rows = [
  'dsh-codex-mode/plugins/tools/exec-command.js',
  'dsh-codex-mode/plugins/tools/apply-patch.js',
  'dsh-codex-mode/plugins/tools/view-image.js',
  'dsh-codex-mode/plugins/tools/restrict.js',
]

for (const specifier of rows) {
  const relative = specifier.replace(/^dsh-codex-mode\//, '')
  const resolved = pathToFileURL(join(packageRoot, relative)).href
  const mod = await import(resolved)
  assert.equal(typeof mod.apply, 'function', `${specifier}: apply is a function`)
  assert.equal(typeof mod.name, 'string', `${specifier}: name exported`)
  assert.ok(Array.isArray(mod.inject), `${specifier}: inject exported`)
  console.log(`OK ${mod.name} ← ${specifier}`)
}

const composition = await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8')
for (const needle of [
  'id: compaction',
  'name: \'@deepseek-ai/dsh-compaction-basic\'',
  'name: \'@deepseek-ai/dsh-command-compact\'',
  'name: \'@deepseek-ai/dsh-compaction-tool-result-pruner\'',
  ...rows.map((specifier) => `name: '${specifier}'`),
]) {
  assert.ok(composition.includes(needle), `composition must include ${needle}`)
}
assert.equal(composition.includes('../../plugins/tools/'), false, 'composition must not use repo-relative plugin paths')
console.log('OK compaction group and package-export tool rows present')
console.log('preset rows check: ALL PASS')
