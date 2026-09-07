/**
 * Smoke test for plugins/win32-atomic-write-fallback.js.
 *
 * Covers: permission-error classification, primary-then-rename fallback,
 * internals install/restore, apply() fiber dispose, and a live
 * LocalFileSystem write on ReFS when that volume is present.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply,
  inject,
  installFallback,
  isWin32PermissionError,
  name,
  withWin32Fallback,
} from './win32-atomic-write-fallback.js'

assert.equal(name, 'win32-atomic-write-fallback')
assert.deepEqual(inject, ['fs'])

const access = new Error('SetFileSecurityW EACCES (Win32 5): C:\\tmp\\x.tmp')
access.code = 'EACCES'
access.syscall = 'SetFileSecurityW'
assert.equal(isWin32PermissionError(access), true, 'EACCES is a permission error')

const replaceDenied = new Error('ReplaceFileW EACCES (Win32 5): C:\\tmp\\x')
replaceDenied.code = 'EACCES'
replaceDenied.syscall = 'ReplaceFileW'
assert.equal(isWin32PermissionError(replaceDenied), true, 'ReplaceFileW EACCES is a permission error')

const io = new Error('ReplaceFileW EIO (Win32 1): C:\\tmp\\x')
io.code = 'EIO'
io.syscall = 'ReplaceFileW'
assert.equal(isWin32PermissionError(io), false, 'EIO is not a permission error')
assert.equal(isWin32PermissionError('nope'), false)

const fallback = withWin32Fallback(
  async () => {
    throw access
  },
  async () => 'renamed',
)
assert.equal(await fallback(), 'renamed')

await assert.rejects(
  () => withWin32Fallback(async () => { throw io }, async () => 'nope')(),
  /EIO/,
  'non-permission errors still throw',
)

const ok = withWin32Fallback(async () => 'kept', async () => 'renamed')
assert.equal(await ok(), 'kept', 'successful primary is not replaced')

const internals = {}
const previousCopy = async () => {
  throw access
}
const previousReplace = async () => {
  throw replaceDenied
}
internals.copyFileDacl = previousCopy
internals.replaceFile = previousReplace
const dispose = installFallback(internals)
assert.notEqual(internals.copyFileDacl, previousCopy)
assert.notEqual(internals.replaceFile, previousReplace)
await internals.copyFileDacl('src', 'dst')
const dir = await mkdtemp(join(tmpdir(), 'dsh-win32-atomic-'))
try {
  const replaced = join(dir, 'target.txt')
  const replacement = join(dir, 'temp.txt')
  await writeFile(replaced, 'old\n')
  await writeFile(replacement, 'new\n')
  await internals.replaceFile(replaced, replacement)
  assert.equal(await readFile(replaced, 'utf8'), 'new\n')
} finally {
  await rm(dir, { recursive: true, force: true })
}
dispose()
assert.equal(internals.copyFileDacl, previousCopy)
assert.equal(internals.replaceFile, previousReplace)

const empty = {}
const emptyDispose = installFallback(empty)
assert.equal(typeof empty.copyFileDacl, 'function')
assert.equal(typeof empty.replaceFile, 'function')
emptyDispose()
assert.equal('copyFileDacl' in empty, false)
assert.equal('replaceFile' in empty, false)

const fs = { internals: {} }
const effects = []
apply({
  fs,
  effect(setup) {
    const uninstall = setup()
    effects.push(uninstall)
    return uninstall
  },
})
if (process.platform === 'win32') {
  assert.equal(typeof fs.internals.copyFileDacl, 'function')
  for (const uninstall of effects) uninstall()
  assert.equal('copyFileDacl' in fs.internals, false)
} else {
  assert.equal(effects.length, 0)
}

async function importFsLocal() {
  try {
    return await import('@deepseek-ai/dsh-fs-local')
  } catch {
    try {
      const resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-fs-local')
      return await import(pathToFileURL(resolved).href)
    } catch {
      return undefined
    }
  }
}

const fsLocal = await importFsLocal()
if (fsLocal !== undefined && process.platform === 'win32') {
  const { LocalFileSystem } = fsLocal
  const ctx = { reflect: { provide() { return () => {} } } }
  const ntfsDir = await mkdtemp(join(tmpdir(), 'dsh-win32-atomic-ntfs-'))
  try {
    const ntfs = new LocalFileSystem(ctx, { cwd: ntfsDir, diffBasisMaxBytes: 1024 * 1024 })
    const uninstall = installFallback(ntfs.internals)
    const path = join(ntfsDir, 'a.txt')
    await writeFile(path, 'old\n')
    const target = await ntfs.resolve(path, { cwd: ntfsDir })
    const outcome = await ntfs.writeText(target, 'new\n')
    assert.equal(outcome.operation, 'update')
    assert.equal(await readFile(path, 'utf8'), 'new\n')
    uninstall()
  } finally {
    await rm(ntfsDir, { recursive: true, force: true })
  }

  const refsDir = 'E:\\texus\\src\\poker_parser'
  if (existsSync(refsDir)) {
    const probe = join(refsDir, `__win32_atomic_probe_${process.pid}.txt`)
    await writeFile(probe, 'old\n')
    try {
      const bare = new LocalFileSystem(ctx, { cwd: refsDir, diffBasisMaxBytes: 1024 * 1024 })
      const target = await bare.resolve(probe, { cwd: refsDir })
      await assert.rejects(
        () => bare.writeText(target, 'should-fail\n'),
        /SetFileSecurityW EACCES \(Win32 5\)/,
        'unpatched ReFS write still hits SetFileSecurityW',
      )
      assert.equal(await readFile(probe, 'utf8'), 'old\n', 'failed write leaves original content')

      const patched = new LocalFileSystem(ctx, { cwd: refsDir, diffBasisMaxBytes: 1024 * 1024 })
      const uninstall = installFallback(patched.internals)
      const patchedTarget = await patched.resolve(probe, { cwd: refsDir })
      const outcome = await patched.writeText(patchedTarget, 'patched\n')
      assert.equal(outcome.operation, 'update')
      assert.equal(await readFile(probe, 'utf8'), 'patched\n')
      uninstall()
    } finally {
      await rm(probe, { force: true })
    }
  }
}

console.log('win32-atomic-write-fallback smoke test: ALL PASS')
