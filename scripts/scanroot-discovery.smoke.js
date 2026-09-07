/**
 * Regression: dsh-agent-presets scanRoot skips junctions / reparse points
 * (`Dirent.isDirectory()` is false). The live `codex` preset MUST therefore
 * be a real directory, carry the compaction group, and resolve its tools.
 *
 * Usage: node scripts/scanroot-discovery.smoke.js
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = join(DSH_HOME, '.agent-presets')
const children = await readdir(root, { withFileTypes: true })

const kept = []
const skipped = []
for (const child of children) {
  const row = {
    name: child.name,
    isDirectory: child.isDirectory(),
    isSymbolicLink: child.isSymbolicLink(),
  }
  if (child.isDirectory()) kept.push(row)
  else skipped.push(row)
}

async function assertLivePreset(id, extraNeedles = []) {
  const live = kept.find((row) => row.name === id)
  assert.ok(live, `scanRoot would skip the live ${id} preset. kept=${kept.map((r) => r.name).join(',')} skipped=${skipped.map((r) => r.name).join(',')}`)
  assert.equal(live.isSymbolicLink, false, `live ${id} preset must not be a symlink/junction Dirent`)

  const dir = join(root, id)
  const info = await stat(dir)
  assert.ok(info.isDirectory(), `${dir} must be a real directory`)

  const composition = await readFile(join(dir, 'agent.cordis.yml'), 'utf8')
  for (const needle of ['id: compaction', 'dsh-compaction-basic', 'dsh-command-compact', ...extraNeedles]) {
    assert.ok(composition.includes(needle), `live ${id} composition missing ${needle}`)
  }
  assert.ok(
    composition.includes('exec-command.js'),
    `live ${id} composition must name exec-command.js (package export or file URL)`,
  )
  console.log(`OK live ${id} preset is a real directory visible to scanRoot`)
}

await assertLivePreset('codex')
await assertLivePreset('codex-creative', ['id: tool-cordis', 'id: planning', 'id: tool-workflow'])
console.log('OK live compositions include compaction group and exec-command')
console.log('scanRoot discovery check: ALL PASS')
