/** Run the suite with one dependency tree, without editing installed packages
 * or the checkout's external node_modules junctions. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const source = path.resolve(import.meta.dirname, '..')
const deps = fs.realpathSync(process.env.DSH_TEST_DEPENDENCIES || path.join(source, 'node_modules'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolated-'))
try {
  for (const name of ['plugins', 'scripts', 'agent-presets', 'package.json', 'cordis.patch.yml', 'README.md', 'assets', 'screenshots.json']) {
    const from = path.join(source, name)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(root, name), { recursive: true, filter: file => path.basename(file) !== 'node_modules' })
  }
  fs.symlinkSync(deps, path.join(root, 'node_modules'), 'junction')
  const npmCli = process.env.npm_execpath || createRequire(import.meta.url).resolve('npm/bin/npm-cli.js')
  const result = spawnSync(process.execPath, [npmCli, ...(process.argv.length > 2 ? process.argv.slice(2) : ['test'])], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), 'dsh-codex-test-npm-cache') },
  })
  process.exitCode = result.status ?? 1
} finally { fs.rmSync(root, { recursive: true, force: true }) }
