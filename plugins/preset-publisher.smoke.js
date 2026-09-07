/**
 * Smoke test for plugins/preset-publisher.js.
 *
 * Covers: first publish, idempotent second publish, refresh when the source
 * composition changes, rewrite of package-export tool rows to file: URLs,
 * adoption of an unmarked bundled-looking directory, skip of a
 * user-owned directory, and dual publish of `codex` + `codex-creative`.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const {
  publishCodexPreset,
  publishAllPresets,
  publishPreset,
  PRESETS,
  name,
  inject,
  apply,
} = await import('./preset-publisher.js')

assert.equal(name, 'codex-preset-publisher')
assert.deepEqual(inject, [])
assert.deepEqual(PRESETS.map((row) => row.id), ['codex', 'codex-creative'])

const root = mkdtempSync(join(tmpdir(), 'dsh-codex-preset-'))
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoSource = join(repoRoot, 'agent-presets', 'codex')
const sourceDir = join(root, 'source')
cpSync(repoSource, sourceDir, { recursive: true })

try {
  const targetDir = join(root, 'codex')
  const first = publishCodexPreset({ sourceDir, targetDir })
  assert.equal(first.action, 'published')
  assert.equal(first.presetId, 'codex')
  const published = readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8')
  assert.ok(published.includes('id: compaction'))
  assert.equal(published.includes("name: 'dsh-codex-mode/plugins/tools/"), false)
  const execUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'tools', 'exec-command.js')).href
  assert.ok(published.includes(`name: '${execUrl}'`), `expected file URL ${execUrl}`)
  const marker = JSON.parse(readFileSync(join(targetDir, '.dsh-codex-mode-published'), 'utf8'))
  assert.equal(marker.publisher, 'dsh-codex-mode')
  assert.equal(marker.presetId, 'codex')
  assert.equal(marker.fingerprint, first.fingerprint)

  const second = publishCodexPreset({ sourceDir, targetDir })
  assert.equal(second.action, 'unchanged')

  writeFileSync(join(sourceDir, 'agent.cordis.yml'), `${readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')}\n# source bump\n`)
  const third = publishCodexPreset({ sourceDir, targetDir })
  assert.equal(third.action, 'updated')
  assert.ok(readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8').includes('id: compaction'))

  rmSync(join(targetDir, '.dsh-codex-mode-published'), { force: true })
  const adopted = publishCodexPreset({ sourceDir, targetDir })
  assert.equal(adopted.action, 'updated')
  assert.ok(existsSync(join(targetDir, '.dsh-codex-mode-published')))

  const userOwned = join(root, 'user-codex')
  mkdirSync(userOwned)
  writeFileSync(join(userOwned, 'agent.cordis.yml'), '# user authored, keep me\n')
  writeFileSync(join(userOwned, 'preset.yml'), 'name: mine\n')
  const skipped = publishCodexPreset({ sourceDir, targetDir: userOwned })
  assert.equal(skipped.action, 'skipped-user-owned')
  assert.equal(readFileSync(join(userOwned, 'agent.cordis.yml'), 'utf8'), '# user authored, keep me\n')

  const creativeSource = join(repoRoot, 'agent-presets', 'codex-creative')
  const creativeTarget = join(root, 'codex-creative')
  const creative = publishPreset({
    id: 'codex-creative',
    displayName: 'codex 创造模式',
    sourceDir: creativeSource,
    targetDir: creativeTarget,
  })
  assert.equal(creative.action, 'published')
  assert.equal(creative.presetId, 'codex-creative')
  const creativeComposition = readFileSync(join(creativeTarget, 'agent.cordis.yml'), 'utf8')
  assert.ok(creativeComposition.includes('id: tool-cordis'))
  assert.ok(creativeComposition.includes('id: planning'))
  assert.ok(creativeComposition.includes('id: tool-workflow'))
  assert.equal(creativeComposition.includes("name: 'dsh-codex-mode/plugins/tools/"), false)
  assert.ok(creativeComposition.includes(`name: '${execUrl}'`))
  assert.ok(existsSync(join(creativeTarget, 'skills', 'editing-cordis-compositions', 'SKILL.md')))
  assert.ok(existsSync(join(creativeTarget, 'skills', 'cordis-plugin-development', 'SKILL.md')))
  const creativeMarker = JSON.parse(readFileSync(join(creativeTarget, '.dsh-codex-mode-published'), 'utf8'))
  assert.equal(creativeMarker.presetId, 'codex-creative')

  const logs = []
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    apply({ logger: { info(message) { logs.push(message) } } })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(logs.length, 2)
  assert.match(logs[0], /preset codex (published|updated|unchanged): /)
  assert.match(logs[1], /preset codex-creative (published|updated|unchanged): /)
  const viaApply = join(root, '.agent-presets', 'codex', 'preset.yml')
  assert.ok(readFileSync(viaApply, 'utf8').includes('codex 工具模式'))
  const viaApplyCreative = join(root, '.agent-presets', 'codex-creative', 'preset.yml')
  assert.ok(readFileSync(viaApplyCreative, 'utf8').includes('codex 创造模式'))
  const viaApplyCreativeComposition = readFileSync(join(root, '.agent-presets', 'codex-creative', 'agent.cordis.yml'), 'utf8')
  assert.ok(viaApplyCreativeComposition.includes('id: tool-cordis'))
  assert.ok(existsSync(join(root, '.agent-presets', 'codex-creative', 'skills', 'editing-cordis-compositions', 'SKILL.md')))

  const all = publishAllPresets({ dshHome: join(root, 'all-home') })
  assert.deepEqual(all.map((row) => row.presetId), ['codex', 'codex-creative'])
  assert.ok(all.every((row) => row.action === 'published'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('preset-publisher smoke test: ALL PASS')
