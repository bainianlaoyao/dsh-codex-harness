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
 * And asserts the skill surface (`skill-filesystem` + `tool-skill`). Those two
 * rows are what turn `/name` and the composer's `/` menu into anything at all:
 * the web surface disables the host-plane copies, so a preset that omits them
 * gets no `skill` tool, no `<available_skills>` catalog, and an empty menu.
 *
 * And asserts the goal surface (`command-goal` + `tool-goal`) for the same
 * reason: the web surface disables the host-plane goal rows too, so omitting
 * them leaves the session with no `/goal` and no `create_goal` / `get_goal` /
 * `update_goal` — a long-running objective can never be armed.
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
  'dsh-codex-mode/plugins/typed-subagents.js',
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
  'id: skill-filesystem',
  'name: \'@deepseek-ai/dsh-skill-filesystem\'',
  'id: tool-skill',
  'name: \'@deepseek-ai/dsh-tool-skill\'',
  'id: command-goal',
  'name: \'@deepseek-ai/dsh-command-goal\'',
  'id: tool-goal',
  'name: \'@deepseek-ai/dsh-tool-goal\'',
  ...rows.map((specifier) => `name: '${specifier}'`),
]) {
  assert.ok(composition.includes(needle), `composition must include ${needle}`)
}
assert.equal(composition.includes('../../plugins/tools/'), false, 'composition must not use repo-relative plugin paths')

// The persona's wait rule. `exec_command` yields a long command after 10-30 s,
// so a turn often ends because the agent is WAITING for a job rather than
// finished — and the goal-round driver admits a round on every idle transition,
// which charges the goal's round budget for `job_output` waits. Measured on a
// real session before the rule existed: 10 injections, 6 of them while an exec
// session was still live, 5 of them pure-wait rounds on one batch job
// (docs/upstream/2026-09-21-goal-round-driver-pending-jobs.md).
for (const needle of [
  'Waiting is not idleness',
  'do not end your turn just to wait for it',
]) {
  assert.ok(composition.includes(needle), `persona must include ${needle}`)
}
console.log('OK persona states that waiting on a running command is not idleness')
console.log('OK compaction group, skill surface, goal surface, and package-export tool rows present')
console.log('preset rows check: ALL PASS')
