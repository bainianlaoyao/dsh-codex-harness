/**
 * Regression: the BUNDLE PATCH must boot on the standard marketplace install
 * path — `dsh plugin --profile <name> add dsh-codex-mode`, which mounts this
 * package's `cordis.patch.yml` as a bundle layer and resolves its rows relative
 * to the INSTALLED package directory.
 *
 * Why this exists (0.3.0 shipped broken): the bundle patch mounted all seven
 * host rows with PATH-LIKE specifiers (`./plugins/x.js`). `client-modules`
 * derives a row's package root from the row's module location, and a path-like
 * specifier resolves to the nearest ancestor manifest — for every row in this
 * patch, THIS package. Since the package also declares `dsh.client`, all seven
 * rows registered a client source for the same packageName and the registry
 * refused to compose:
 *
 *   client-modules: package dsh-codex-mode resolves from multiple active
 *   Loader sources: …; remove one entry
 *
 * That is a hard boot failure. Two things hid it, and both are handled here:
 *
 * 1. The maintainer's own profile never hit it, because it keeps this package
 *    out of `dsh.profile.bundles` and mounts the host rows through
 *    profile-local facades — so hand-verifying that one profile proved nothing
 *    about the marketplace path.
 * 2. The repo carries `plugins/package.json` (private, name `dsh-codex`) which
 *    is NOT in the published `files` list. In-repo, that manifest shadows
 *    package-root detection and makes path-like rows resolve to a package with
 *    no `dsh.client` — so resolving the rows against the REPO tree reported a
 *    clean result for a bundle patch that crashed on install. The check below
 *    therefore resolves against a materialized replica of the SHIPPED layout
 *    (built from `npm pack --dry-run --json`), not against the working tree.
 *
 * Usage: node scripts/bundle-patch.smoke.js
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

/** Parse the `insert:` rows (id + name) out of a bundle patch. */
function insertRows(text) {
  const rows = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const id = /^\s+- id:\s*(.+?)\s*$/.exec(line)
    if (id) {
      current = { id: unquote(id[1]) }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const name = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (name && current.name === undefined) current.name = unquote(name[1])
  }
  return rows.filter((row) => row.name !== undefined)
}
const unquote = (value) => value.replace(/^['"]|['"]$/g, '')

/** Exported file for one `exports` subpath, accepting the string and `default` forms. */
function exportTarget(exportsField, subpath) {
  const entry = exportsField?.[subpath]
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null && typeof entry.default === 'string') return entry.default
  return undefined
}

// ── Materialize the SHIPPED layout ──────────────────────────────────────────
// `npm pack --dry-run --json` is the authority on what an install receives.
// `npm` is a shell script/cmd shim, not a spawnable executable on Windows.
// One whole command string (no args array) keeps the shell path warning-free.
const packed = JSON.parse(process.platform === 'win32'
  ? execFileSync('npm pack --dry-run --json', { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true })
  : execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0]
const shipped = new Set(packed.files.map((file) => file.path.replace(/\\/g, '/')))

const root = mkdtempSync(join(tmpdir(), 'dsh-codex-bundle-patch-'))
try {
  // A real install places the package under <profile>/node_modules/<name>, which
  // is also what lets the bare-name row resolve; the replica must match.
  const installedDir = join(root, 'node_modules', manifest.name)
  for (const relative of shipped) {
    const target = join(installedDir, relative)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(packageDir, relative), target)
  }
  const baseUrl = pathToFileURL(installedDir).href + '/'

  const { ClientModuleRegistry } = await import('@deepseek-ai/dsh-client-modules')
  const registry = Object.create(ClientModuleRegistry.prototype)
  registry.pkgMeta = new Map()
  registry.ctx = { loader: {} } // no `loader.internal`: exercises the package-root branch

  const rows = insertRows(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8'))
  assert.ok(rows.length >= 1, 'bundle patch must mount at least one row')

  const sources = new Map()
  for (const row of rows) {
    let resolved
    try {
      resolved = registry.resolveMeta(row.name, baseUrl)
    } catch (error) {
      assert.fail(`bundle patch row ${row.id} (${row.name}) failed to resolve on the shipped layout: ${error.message}`)
    }
    if (resolved === null) continue
    if (!sources.has(resolved.packageName)) sources.set(resolved.packageName, [])
    sources.get(resolved.packageName).push({ row: row.id, name: row.name, clientPath: resolved.meta.clientPath })
  }

  // 1. The exact defect that shipped in 0.3.0.
  for (const [packageName, list] of sources) {
    assert.equal(
      list.length,
      1,
      `the shipped bundle patch mounts ${list.length} client-bearing rows for ${packageName} ` +
        `(${list.map((entry) => `${entry.row} (${entry.name})`).join(', ')}). ` +
        'client-modules refuses to compose a package with multiple active Loader sources, which ' +
        'fails the boot. Keep exactly one bare-package-name row and use bare package SUBPATHS ' +
        '(which register no source) or another package for the rest.',
    )
  }

  // 2. This package ships plugins/client.js, so it MUST be client-bearing once —
  //    otherwise the settings page silently never reaches the browser.
  assert.ok(manifest.dsh?.client !== undefined, 'package.json declares no dsh.client; the client half would never be composed')
  assert.equal(manifest.dsh.client.platform, 'web')
  const own = sources.get(manifest.name)
  assert.ok(own, `no row of the shipped bundle patch resolves the package root of ${manifest.name}; the client half would never be composed`)
  const clientPath = own[0].clientPath
  assert.ok(statSync(clientPath).isFile(), `composed client bundle does not exist: ${clientPath}`)
  assert.equal(
    clientPath,
    join(installedDir, exportTarget(manifest.exports, './client') ?? ''),
    'the composed client bundle is not exports["./client"] — the client-bearing row must resolve the package ROOT export',
  )
  assert.ok(
    readFileSync(clientPath, 'utf8').includes('__ModuleLoader__.load'),
    'the composed client bundle does not register itself via __ModuleLoader__.load',
  )

  // 3. Layout-independent guard: a path-like row ALWAYS resolves to the nearest
  //    ancestor manifest, which can only be this package or a nested one. Keeping
  //    them out is what makes the single-source invariant above hold.
  const pathLike = rows.filter((row) => /^\.{1,2}\//.test(row.name) || row.name.startsWith('file:'))
  assert.deepEqual(
    pathLike.map((row) => row.name),
    [],
    "bundle patch rows must not use path-like specifiers: they resolve to this package's own " +
      'manifest and register a second client source for it (the 0.3.0 boot failure)',
  )

  // 4. Every row's host half must actually ship and be exported, or the boot
  //    fails on import — and a row added without a `files`/`exports` update is
  //    the same class of install-only breakage.
  for (const row of rows) {
    const subpath = row.name === manifest.name
      ? '.'
      : row.name.startsWith(`${manifest.name}/`)
        ? `./${row.name.slice(manifest.name.length + 1)}`
        : undefined
    assert.ok(subpath, `bundle patch row ${row.id} (${row.name}) must mount this package by bare name or bare subpath`)
    const target = exportTarget(manifest.exports, subpath)
    assert.ok(target, `bundle patch row ${row.id} (${row.name}) has no exports["${subpath}"] entry`)
    assert.ok(
      shipped.has(target.replace(/^\.\//, '')),
      `bundle patch row ${row.id} (${row.name}) resolves to ${target}, which the published package does NOT ship — add it to package.json "files"`,
    )
    assert.ok(existsSync(join(installedDir, target)), `bundle patch row ${row.id} (${row.name}) target is missing from the shipped layout: ${target}`)
  }

  // 5. README images must ship too: a relative reference to a file outside
  //    `files` renders as a broken image on the registry page.
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')
  const images = [...readme.matchAll(/!\[[^\]]*\]\(\s*(?!https?:|data:|#)([^)\s]+)/g)].map((match) => match[1].replace(/^\.\//, ''))
  for (const image of images) {
    assert.ok(
      shipped.has(image),
      `README references ${image}, which the published package does NOT ship — add it to package.json "files"`,
    )
  }

  console.log(
    `bundle patch install check: ALL PASS (${rows.length} rows, ${sources.size} client-bearing package(s), ` +
      `one source for ${manifest.name}, ${shipped.size} shipped files)`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
