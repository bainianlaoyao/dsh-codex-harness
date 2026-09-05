/**
 * Publish the bundled `codex` agent preset into the user roster on host boot.
 *
 * `dsh plugin add` only applies this package's cordis.patch.yml (host rows).
 * Agent presets are discovered from `$DSH_HOME/.agent-presets`, so the plugin
 * copies `agent-presets/codex` there as a REAL directory. Junctions are
 * invisible to `dsh-agent-presets` scanRoot (`Dirent.isDirectory()` is false).
 *
 * Preset rows that name a package resolve from the harness, not the profile
 * node_modules, so the published composition rewrites this package's tool
 * specifiers to absolute `file:` URLs. That keeps `dsh plugin add` and a
 * local checkout on the same path.
 *
 * The copy is owned by this package: a local marker records the published
 * version, and each boot refreshes the files when the package version or
 * source composition changes. A user-authored directory without the marker
 * (and not named "codex 工具模式") is left alone.
 *
 * @module dsh-codex/preset-publisher
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'codex-preset-publisher'
export const inject = []

const PRESET_ID = 'codex'
const MARKER_FILE = '.dsh-codex-mode-published'
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = join(PACKAGE_ROOT, 'agent-presets', PRESET_ID)

const TOOL_EXPORTS = {
  'dsh-codex-mode/plugins/tools/restrict.js': 'plugins/tools/restrict.js',
  'dsh-codex-mode/plugins/tools/exec-command.js': 'plugins/tools/exec-command.js',
  'dsh-codex-mode/plugins/tools/apply-patch.js': 'plugins/tools/apply-patch.js',
  'dsh-codex-mode/plugins/tools/view-image.js': 'plugins/tools/view-image.js',
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function fingerprint(dir) {
  const files = ['agent.cordis.yml', 'preset.yml', 'check-rows.mjs']
  const hash = createHash('sha256')
  for (const file of files) {
    const path = join(dir, file)
    hash.update(file)
    hash.update('\0')
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '0'
  } catch {
    return '0'
  }
}

function readMarker(target) {
  const path = join(target, MARKER_FILE)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function looksLikeBundledPreset(target) {
  try {
    const metadata = readFileSync(join(target, 'preset.yml'), 'utf8')
    return metadata.includes('name: codex 工具模式')
  } catch {
    return false
  }
}

function rewritePublishedComposition(target) {
  const file = join(target, 'agent.cordis.yml')
  let text = readFileSync(file, 'utf8')
  for (const [specifier, relative] of Object.entries(TOOL_EXPORTS)) {
    const url = pathToFileURL(join(PACKAGE_ROOT, relative)).href
    text = text.split(`name: '${specifier}'`).join(`name: '${url}'`)
  }
  writeFileSync(file, text)
}

function writeMarker(target, version, sourceFingerprint) {
  writeFileSync(join(target, MARKER_FILE), `${JSON.stringify({
    publisher: 'dsh-codex-mode',
    version,
    fingerprint: sourceFingerprint,
    presetId: PRESET_ID,
  }, null, 2)}\n`)
}

/**
 * Copy the bundled preset into the user roster when missing or stale.
 * @returns {{ action: string, target: string, version: string, fingerprint: string }}
 */
export function publishCodexPreset(options = {}) {
  const source = options.sourceDir ?? SOURCE_DIR
  const target = options.targetDir ?? join(dshHome(), '.agent-presets', PRESET_ID)
  const version = packageVersion()
  const sourceFingerprint = fingerprint(source)
  if (!existsSync(join(source, 'agent.cordis.yml'))) {
    throw new Error(`codex-preset-publisher: bundled preset missing at ${source}`)
  }

  const existing = existsSync(target)
  if (existing) {
    const marker = readMarker(target)
    if (marker === null && !looksLikeBundledPreset(target)) {
      return { action: 'skipped-user-owned', target, version, fingerprint: sourceFingerprint }
    }
    if (
      marker !== null
      && marker.version === version
      && marker.fingerprint === sourceFingerprint
    ) {
      return { action: 'unchanged', target, version, fingerprint: sourceFingerprint }
    }
    rmSync(target, { recursive: true, force: true })
  }

  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: true })
  rewritePublishedComposition(target)
  writeMarker(target, version, sourceFingerprint)
  return {
    action: existing ? 'updated' : 'published',
    target,
    version,
    fingerprint: sourceFingerprint,
  }
}

export function apply(ctx) {
  try {
    const result = publishCodexPreset()
    ctx.logger?.info?.(`[dsh-codex-mode] preset ${result.action}: ${result.target}`)
  } catch (error) {
    ctx.logger?.error?.(error)
    throw error
  }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = publishCodexPreset()
  console.log(`[dsh-codex-mode] preset ${result.action}: ${result.target}`)
}
