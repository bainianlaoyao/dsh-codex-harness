/**
 * Smoke test for plugins/preset-publisher.js.
 *
 * Covers: first publish, idempotent second publish, refresh when the source
 * composition changes, rewrite of package-export tool rows to file: URLs,
 * adoption of an unmarked bundled-looking directory, and skip of a
 * user-owned directory.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { publishCodexPreset, name, inject, apply } = await import('./preset-publisher.js')

assert.equal(name, 'codex-preset-publisher')
assert.deepEqual(inject, [])

const root = mkdtempSync(join(tmpdir(), 'dsh-codex-preset-'))
const repoSource = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-presets', 'codex')
const sourceDir = join(root, 'source')
cpSync(repoSource, sourceDir, { recursive: true })

try {
  const targetDir = join(root, 'codex')
  const first = publishCodexPreset({ sourceDir, targetDir })
  assert.equal(first.action, 'published')
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

  const logs = []
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    apply({ logger: { info(message) { logs.push(message) } } })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(logs.length, 1)
  assert.match(logs[0], /preset (published|updated|unchanged): /)
  const viaApply = join(root, '.agent-presets', 'codex', 'preset.yml')
  assert.ok(readFileSync(viaApply, 'utf8').includes('codex 工具模式'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('preset-publisher smoke test: ALL PASS')
