/**
 * Publish bundled agent presets into the user roster on host boot.
 *
 * `dsh plugin add` only applies this package's cordis.patch.yml (host rows).
 * Agent presets are discovered from `$DSH_HOME/.agent-presets`, so the plugin
 * copies each bundled preset there as a REAL directory. Junctions are
 * invisible to `dsh-agent-presets` scanRoot (`Dirent.isDirectory()` is false).
 *
 * Preset rows that name a package resolve from the harness, not the profile
 * node_modules, so the published composition rewrites this package's tool
 * specifiers to absolute `file:` URLs. That keeps `dsh plugin add` and a
 * local checkout on the same path.
 *
 * Each copy is owned by this package: a local marker records the published
 * version, and each boot refreshes the files when the package version or
 * source composition changes. A user-authored directory without the marker
 * (and not named as this package's display name) is left alone.
 *
 * @module dsh-codex/preset-publisher
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'codex-preset-publisher'
export const inject = []

export const PRESETS = [
  { id: 'codex', displayName: 'codex 工具模式' },
  { id: 'codex-creative', displayName: 'codex 创造模式' },
]

const MARKER_FILE = '.dsh-codex-mode-published'
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const TOOL_EXPORTS = {
  'dsh-codex-mode/plugins/typed-subagents.js': 'plugins/typed-subagents.js',
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

function collectFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== MARKER_FILE)
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function fingerprint(dir) {
  const hash = createHash('sha256')
  for (const file of collectFiles(dir)) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(dir, ...file.split('/'))))
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

function looksLikeBundledPreset(target, displayName) {
  try {
    const metadata = readFileSync(join(target, 'preset.yml'), 'utf8')
    return metadata.includes(`name: ${displayName}`)
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

function writeMarker(target, version, sourceFingerprint, presetId) {
  writeFileSync(join(target, MARKER_FILE), `${JSON.stringify({
    publisher: 'dsh-codex-mode',
    version,
    fingerprint: sourceFingerprint,
    presetId,
  }, null, 2)}\n`)
}

/**
 * Copy one bundled preset into the user roster when missing or stale.
 * @returns {{ action: string, target: string, version: string, fingerprint: string, presetId: string }}
 */
export function publishPreset(options = {}) {
  const presetId = options.id ?? 'codex'
  const displayName = options.displayName ?? PRESETS.find((row) => row.id === presetId)?.displayName ?? presetId
  const source = options.sourceDir ?? join(PACKAGE_ROOT, 'agent-presets', presetId)
  const target = options.targetDir ?? join(dshHome(), '.agent-presets', presetId)
  const version = packageVersion()
  const sourceFingerprint = fingerprint(source)
  if (!existsSync(join(source, 'agent.cordis.yml'))) {
    throw new Error(`codex-preset-publisher: bundled preset missing at ${source}`)
  }

  const existing = existsSync(target)
  if (existing) {
    const marker = readMarker(target)
    if (marker === null && !looksLikeBundledPreset(target, displayName)) {
      return { action: 'skipped-user-owned', target, version, fingerprint: sourceFingerprint, presetId }
    }
    if (
      marker !== null
      && marker.version === version
      && marker.fingerprint === sourceFingerprint
      && marker.presetId === presetId
    ) {
      return { action: 'unchanged', target, version, fingerprint: sourceFingerprint, presetId }
    }
    rmSync(target, { recursive: true, force: true })
  }

  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: true })
  rewritePublishedComposition(target)
  writeMarker(target, version, sourceFingerprint, presetId)
  return {
    action: existing ? 'updated' : 'published',
    target,
    version,
    fingerprint: sourceFingerprint,
    presetId,
  }
}

/**
 * Copy the bundled `codex` agent preset into the user roster when missing or stale.
 * @returns {{ action: string, target: string, version: string, fingerprint: string, presetId: string }}
 */
export function publishCodexPreset(options = {}) {
  return publishPreset({
    id: 'codex',
    displayName: 'codex 工具模式',
    sourceDir: options.sourceDir,
    targetDir: options.targetDir,
  })
}

/**
 * Copy every bundled preset into the user roster.
 * @returns {Array<{ action: string, target: string, version: string, fingerprint: string, presetId: string }>}
 */
export function publishAllPresets(options = {}) {
  const home = options.dshHome ?? dshHome()
  return PRESETS.map((preset) => publishPreset({
    id: preset.id,
    displayName: preset.displayName,
    sourceDir: options.sourceDirById?.[preset.id] ?? join(PACKAGE_ROOT, 'agent-presets', preset.id),
    targetDir: options.targetDirById?.[preset.id] ?? join(home, '.agent-presets', preset.id),
  }))
}

export function apply(ctx) {
  try {
    const results = publishAllPresets()
    for (const result of results) {
      ctx.logger?.info?.(`[dsh-codex-mode] preset ${result.presetId} ${result.action}: ${result.target}`)
    }
  } catch (error) {
    ctx.logger?.error?.(error)
    throw error
  }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  for (const result of publishAllPresets()) {
    console.log(`[dsh-codex-mode] preset ${result.presetId} ${result.action}: ${result.target}`)
  }
}
