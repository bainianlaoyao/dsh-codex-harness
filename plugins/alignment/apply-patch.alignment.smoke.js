/**
 * Alignment test: apply_patch vs codex official HEAD golden data.
 *
 * Reads fixtures extracted from codex-rs/core/tests/suite/apply_patch_cli.rs
 * (patch text + seeded files + expected file effects / failure messages) and
 * drives tools/apply-patch.js through an in-memory mock fs, asserting the
 * same outcomes the official integration tests assert.
 *
 * Usage: node dsh-codex/alignment/apply-patch.alignment.smoke.js
 *        (from the profile root)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/apply-patch.cases.json', import.meta.url), 'utf8'))

/** Minimal in-memory fs matching the apply-patch.js ctx.fs contract. */
function makeFs(seed) {
  const files = new Map()
  const dirs = new Set(['C:/tmp'])
  for (const [path, content] of Object.entries(seed)) {
    if (content !== null) {
      files.set(`C:/tmp/${path}`, content)
      const segments = path.replace(/\\/g, '/').split('/')
      let acc = 'C:/tmp'
      for (let i = 0; i < segments.length - 1; i++) {
        acc += '/' + segments[i]
        dirs.add(acc)
      }
    }
  }
  const norm = (base, p) => {
    const isAbs = /^[A-Za-z]:/.test(p) || p.startsWith('/')
    const raw = isAbs ? p : `${base}/${p}`
    const parts = []
    for (const seg of raw.replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        parts.pop()
        continue
      }
      parts.push(seg)
    }
    return parts.join('/')
  }
  return {
    async resolve(path, opts = {}) {
      const abs = norm(opts.cwd ?? 'C:/tmp', path)
      return { targetKey: abs, displayPath: abs }
    },
    async stat(target) {
      if (files.has(target.targetKey)) return { version: 'v1', type: 'file', size: files.get(target.targetKey).length }
      if (dirs.has(target.targetKey)) return { version: 'v1', type: 'directory', size: 0 }
      return undefined
    },
    async readText(target) {
      if (dirs.has(target.targetKey)) {
        const error = new Error(`cannot read a directory: ${target.displayPath}`)
        error.code = 'EISDIR'
        throw error
      }
      if (!files.has(target.targetKey)) {
        const error = new Error(`file not found: ${target.displayPath}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(target.targetKey)
    },
    async writeText(target, content) {
      files.set(target.targetKey, content)
      const parts = target.targetKey.replace(/\\/g, '/').split('/')
      parts.pop()
      const parent = parts.join('/')
      if (parent.length > 0) dirs.add(parent)
      return { operation: 'update', version: 'v2', before: null, after: content }
    },
    async delete(target) {
      if (!files.has(target.targetKey)) {
        const error = new Error(`file not found: ${target.displayPath}`)
        error.code = 'FS_NOT_FOUND'
        throw error
      }
      files.delete(target.targetKey)
    },
    async mkdir(target) {
      const raw = target.targetKey.replace(/\\/g, '/')
      const parts = []
      for (const seg of raw.split('/')) {
        if (seg === '' || seg === '.') continue
        parts.push(seg)
        dirs.add(parts.join('/'))
      }
    },
    processPath(target) {
      return target.targetKey
    },
    contains(parent, child) {
      const p = parent.targetKey.replace(/\/+$/, '')
      return child.targetKey === p || child.targetKey.startsWith(`${p}/`)
    },
    snapshot() {
      return Object.fromEntries([...files.entries()].map(([k, v]) => [k.replace(/^C:\/tmp\//, ''), v]))
    },
  }
}

const { apply } = await import('../tools/apply-patch.js')
const captured = []
// The tool's execute() closes over the registration-time ctx, so expose an fs
// proxy that forwards to the current case's in-memory filesystem.
let currentFs
const fsProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (currentFs === undefined) throw new Error('no fs for current case')
      const value = currentFs[prop]
      return typeof value === 'function' ? value.bind(currentFs) : value
    },
  }
)
apply({ tools: { register: (definition) => captured.push(definition) }, fs: fsProxy }, {})
const tool = captured.find((t) => t.name === 'apply_patch')
assert.ok(tool, 'apply_patch registered')

const failures = []
for (const c of fixture.cases) {
  currentFs = makeFs(c.files)
  const exec = {
    agent: { session: { header: { cwd: 'C:/tmp' }, append() {} }, ctx: { effect: () => () => {} } },
    signal: new AbortController().signal,
    callId: `call-${c.name}`,
  }
  let result
  let error
  try {
    result = await tool.execute({ patch: c.patch }, exec)
  } catch (e) {
    error = e
  }
  const expect = c.expect
  const report = (detail) => failures.push({ name: c.name, ref: c.ref, detail })

  if (expect.kind === 'success') {
    if (error) {
      report(`expected success, got error: ${error.message}`)
      continue
    }
    const after = currentFs.snapshot()
    for (const [path, content] of Object.entries(expect.files)) {
      if (content === null) {
        if (after[path] !== undefined) report(`expected ${path} deleted, still present: ${JSON.stringify(after[path])}`)
      } else if (after[path] !== content) {
        report(`expected ${path}=${JSON.stringify(content)}, got ${JSON.stringify(after[path])}`)
      }
    }
    const outputLines = [result.summary, ...result.files.map((f) => `${f.action} ${f.path}`)]
    if (JSON.stringify(outputLines) !== JSON.stringify(expect.outputLines)) {
      report(`output lines mismatch: expected ${JSON.stringify(expect.outputLines)}, got ${JSON.stringify(outputLines)}`)
    }
  } else {
    if (!error) {
      report('expected verification failure, but the patch applied successfully')
      continue
    }
    for (const needle of expect.messageContains) {
      if (!error.message.includes(needle)) report(`error message missing ${JSON.stringify(needle)}: ${error.message}`)
    }
    if (expect.files) {
      const after = currentFs.snapshot()
      for (const [path, content] of Object.entries(expect.files)) {
        if (content === null) {
          if (after[path] !== undefined) report(`expected ${path} to remain absent, but it exists: ${JSON.stringify(after[path])}`)
        } else if (after[path] !== content) {
          report(`expected ${path} untouched (${JSON.stringify(content)}), got ${JSON.stringify(after[path])}`)
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`MISMATCHES vs codex HEAD (${failures.length}):`)
  for (const f of failures) {
    console.error(`  [${f.name}] (${f.ref}) ${f.detail}`)
  }
  process.exit(1)
}

console.log(`apply-patch alignment: ALL PASS (${fixture.cases.length} cases)`)
