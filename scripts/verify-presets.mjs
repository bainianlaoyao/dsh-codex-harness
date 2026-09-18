/**
 * Structural verifier for the two published agent presets.
 *
 * Each preset's own `check-rows.mjs` asserts plain text, which is the right
 * shape for "this exact specifier must appear" but is blind to YAML structure,
 * to duplicate row ids, and to the question "does the loader hand the row a
 * valid name at all". This script parses each composition with js-yaml and then
 * checks the shape of what came out.
 *
 * The invariant it exists for: the web surface disables the host-plane
 * `skill-filesystem` / `tool-skill` rows, so a preset that wants the skill
 * surface (catalog, `skill` tool, `/` composer menu) must mount both itself. The
 * plain `codex` preset shipped for months without them, so a session on it had
 * no skill surface at all — that regression is what these assertions guard.
 *
 * js-yaml is a repo devDependency, so this file reads it from the repo; it is
 * intentionally NOT part of `npm test`'s published-layout checks. Both
 * `check-rows.mjs` files stay the dependency-free gate that `npm test` runs.
 *
 * Usage:
 *   node scripts/verify-presets.mjs                 # the repo's two presets
 *   node scripts/verify-presets.mjs <dir> [<dir>…]  # also verify published copies
 *
 * Passing `$DSH_HOME/.agent-presets/codex` verifies the artifact the running
 * host actually reads, which is the copy the publisher rewrites.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

// The loader's own `!!js` extension is an executable scalar; this verifier only
// needs the tag to parse, so the raw string is the right stand-in.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value) => value,
})
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])

/** Every preset that ships in the package, with the surfaces it must carry. */
const PRESETS = [
  {
    id: 'codex',
    displayName: 'codex 工具模式',
    skills: true,
    toolSpecifiers: [
      'dsh-codex-mode/plugins/typed-subagents.js',
      'dsh-codex-mode/plugins/tools/exec-command.js',
      'dsh-codex-mode/plugins/tools/apply-patch.js',
      'dsh-codex-mode/plugins/tools/view-image.js',
      'dsh-codex-mode/plugins/tools/restrict.js',
    ],
    // Matched as a `name` suffix: a group child's row id is its local alias
    // (`compaction-basic`), while the package it mounts is the real identity.
    compactions: [
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
    ],
  },
  {
    id: 'codex-creative',
    displayName: 'codex 创造模式',
    skills: true,
    toolSpecifiers: [
      'dsh-codex-mode/plugins/typed-subagents.js',
      'dsh-codex-mode/plugins/tools/exec-command.js',
      'dsh-codex-mode/plugins/tools/apply-patch.js',
      'dsh-codex-mode/plugins/tools/view-image.js',
      'dsh-codex-mode/plugins/tools/restrict.js',
    ],
    compactions: [
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
    ],
  },
]

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  OK   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}`)
  }
}

/** Collect row ids recursively: group rows nest their children under `config`. */
const collectIds = (rows, into = []) => {
  for (const row of rows) {
    if (typeof row?.id === 'string') into.push(row.id)
    if (Array.isArray(row?.config)) collectIds(row.config, into)
  }
  return into
}

const namesOf = (rows, into = []) => {
  for (const row of rows) {
    if (typeof row?.name === 'string') into.push(row.name)
    if (Array.isArray(row?.config)) namesOf(row.config, into)
  }
  return into
}

const findRow = (rows, id) => {
  const wanted = id.toLowerCase()
  for (const row of rows) {
    // A group child's row id is a local alias (`compaction-basic`) while the
    // package it mounts is the real identity, so match either, case-insensitively.
    if (typeof row?.id === 'string' && row.id.toLowerCase() === wanted) return row
    if (typeof row?.name === 'string' && row.name.toLowerCase() === wanted) return row
    if (Array.isArray(row?.config)) {
      const nested = findRow(row.config, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

const verifyFile = (label, path, preset) => {
  console.log(`\n${label}`)
  console.log(`  ${path}`)
  if (!existsSync(path)) {
    failures += 1
    console.log('  FAIL file does not exist')
    return
  }
  let rows
  try {
    rows = yaml.load(readFileSync(path, 'utf8'), { schema })
  } catch (error) {
    failures += 1
    console.log(`  FAIL YAML parse: ${error.message.split('\n')[0]}`)
    return
  }

  check('composition is a top-level sequence of rows', () => {
    assert.ok(Array.isArray(rows) && rows.length > 0, 'expected a non-empty YAML sequence')
  })
  if (!Array.isArray(rows)) return

  check('every row has a string id and a name', () => {
    for (const [index, row] of rows.entries()) {
      assert.equal(typeof row?.id, 'string', `row ${index} has no string id`)
      assert.equal(typeof row?.name, 'string', `row ${index} (${row?.id}) has no string name`)
    }
  })

  check('row ids are unique', () => {
    const ids = collectIds(rows)
    const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
    assert.deepEqual(dupes, [], `duplicate row ids: ${dupes.join(', ')}`)
  })

  check('compaction group carries all three rows', () => {
    for (const specifier of preset.compactions) {
      assert.ok(findRow(rows, specifier) !== undefined, `missing row: ${specifier}`)
    }
  })

  if (preset.skills) {
    // The regression this file exists for.
    check('skill surface is mounted (skill-filesystem + tool-skill)', () => {
      const filesystem = findRow(rows, 'skill-filesystem')
      const tool = findRow(rows, 'tool-skill')
      assert.ok(filesystem !== undefined, 'missing skill-filesystem row: the session gets no local discovery')
      assert.ok(tool !== undefined, 'missing tool-skill row: no catalog, no `skill` tool, empty `/` menu')
      assert.equal(filesystem.name, '@deepseek-ai/dsh-skill-filesystem')
      assert.equal(tool.name, '@deepseek-ai/dsh-tool-skill')
      assert.notEqual(filesystem.disabled, true, 'skill-filesystem is disabled')
      assert.notEqual(tool.disabled, true, 'tool-skill is disabled')
    })
  }

  check('Codex tool rows resolve through package exports or a file: URL', () => {
    const names = namesOf(rows).map((name) => name.replaceAll('\\', '/'))
    for (const specifier of preset.toolSpecifiers) {
      // The publisher rewrites these to absolute file: URLs in the published
      // copy, so accept either form but require the same relative path.
      const relative = specifier.replace(/^dsh-codex-mode\//, '')
      const resolved = names.some(
        (name) => name === specifier || (name.startsWith('file:') && name.endsWith(relative)),
      )
      assert.ok(resolved, `missing tool row: ${specifier}`)
    }
  })

  check('no repo-relative plugin paths', () => {
    const relative = namesOf(rows).filter((name) => name.startsWith('.') || name.includes('../'))
    assert.deepEqual(relative, [], `repo-relative names: ${relative.join(', ')}`)
  })
}

const targets = process.argv.slice(2)
const dirs = targets.length > 0 ? targets.map((dir) => resolve(dir)) : []
for (const preset of PRESETS) {
  verifyFile(
    `${preset.id} — repo source`,
    join(repoRoot, 'agent-presets', preset.id, 'agent.cordis.yml'),
    preset,
  )
  for (const dir of dirs) {
    const path = existsSync(join(dir, 'agent.cordis.yml'))
      ? join(dir, 'agent.cordis.yml')
      : join(dir, preset.id, 'agent.cordis.yml')
    verifyFile(`${preset.id} — ${dir}`, path, preset)
  }
}

console.log(failures === 0 ? '\npreset structure verification: ALL PASS' : `\npreset structure verification: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
