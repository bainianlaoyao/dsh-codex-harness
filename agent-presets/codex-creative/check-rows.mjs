/**
 * Mount-shape check for the codex-creative preset.
 *
 * Asserts the Codex tool-surface rows (package exports), the DSH-native
 * compaction group, and the shipped-cordis creative extras: tool-cordis,
 * composition skills, plan mode, goals, workflows, and ralph.
 *
 * Usage: node check-rows.mjs  (from the preset directory)
 */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
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
  'id: planning',
  'name: \'@deepseek-ai/dsh-plan-mode\'',
  'id: tool-goal',
  'name: \'@deepseek-ai/dsh-tool-goal\'',
  'id: command-goal',
  'id: tool-jobs',
  'id: tool-workflow',
  'name: \'@deepseek-ai/dsh-tool-workflow\'',
  'id: tool-ralph',
  'name: \'@deepseek-ai/dsh-tool-ralph\'',
  'id: tool-cordis',
  'name: \'@deepseek-ai/dsh-tool-cordis\'',
  'id: tool-skill',
  'name: \'@deepseek-ai/dsh-tool-skill\'',
  'id: skill-filesystem',
  'customSkillDirs',
  'fetch: true',
  ...rows.map((specifier) => `name: '${specifier}'`),
]) {
  assert.ok(composition.includes(needle), `composition must include ${needle}`)
}
assert.equal(composition.includes('../../plugins/tools/'), false, 'composition must not use repo-relative plugin paths')
assert.equal(composition.includes("name: '@deepseek-ai/dsh-tool-bash'"), false, 'creative preset must not mount dsh-tool-bash')
assert.equal(composition.includes("name: '@deepseek-ai/dsh-tool-fs'"), false, 'creative preset must not mount dsh-tool-fs')

await access(join(presetDir, 'skills', 'editing-cordis-compositions', 'SKILL.md'))
await access(join(presetDir, 'skills', 'cordis-plugin-development', 'SKILL.md'))
console.log('OK compaction, cordis creative extras, skills, and package-export tool rows present')
console.log('preset rows check: ALL PASS')
