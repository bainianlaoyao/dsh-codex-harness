/**
 * win32-atomic-write-fallback — host-plane companion for dsh-fs-local
 *
 * `dsh-fs-local` publishes an existing file through a private sibling staging
 * directory, then on Windows:
 *   1. copies the target DACL onto the empty temp (`SetFileSecurityW` with
 *      PROTECTED_DACL | DACL) so the write is not world-readable via the
 *      staging parent;
 *   2. publishes with `ReplaceFileW` so the target's ACL survives.
 *
 * Both calls require WRITE_DAC. On ReFS volumes (and on NTFS files whose
 * inherited ACL is only `Authenticated Users:(M)` / `Users:(RX)`), the
 * process does not have WRITE_DAC, so `SetFileSecurityW` / `ReplaceFileW`
 * fail with Win32 5 / `EACCES`. `apply_patch` / `write` / `edit` then surface
 * that as `apply_patch verification failed: SetFileSecurityW EACCES ...tmpdir`.
 *
 * Node's `rename` on the same volume still replaces the file. This plugin
 * hooks `ctx.fs.internals` (the documented fsio test/extension seam) so a
 * permission failure on the Win32 ACL path falls back to `rename`. NTFS
 * files that still accept `ReplaceFileW` keep the official publication.
 *
 * Delivered as an installable host row — no official package is patched.
 *
 * @module dsh-codex/win32-atomic-write-fallback
 */

import { createRequire } from 'node:module'
import { rename } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'

export const name = 'win32-atomic-write-fallback'
export const inject = ['fs']

const DACL_SECURITY_INFORMATION = 4
const PROTECTED_DACL_AND_DACL = 2147483652
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5

let nativeApiPromise

/**
 * True when a Win32 ACL / replace call was refused for lack of WRITE_DAC.
 */
export function isWin32PermissionError(error) {
  if (!(error instanceof Error)) return false
  if (error.code === 'EACCES' || error.code === 'EPERM') return true
  if (error.syscall !== 'SetFileSecurityW' && error.syscall !== 'ReplaceFileW' && error.syscall !== 'GetFileSecurityW') {
    return false
  }
  return error.win32Code === ERROR_ACCESS_DENIED || /\bEACCES\b/.test(error.message)
}

function win32Error(syscall, win32Code, path) {
  const code = win32Code === ERROR_FILE_NOT_FOUND || win32Code === ERROR_PATH_NOT_FOUND
    ? 'ENOENT'
    : win32Code === ERROR_ACCESS_DENIED
      ? 'EACCES'
      : 'EIO'
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path}`)
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.win32Code = win32Code
  return error
}

function loadKoffi() {
  try {
    return createRequire(import.meta.url)('koffi')
  } catch {
    try {
      return createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-fs-local'))('koffi')
    } catch {
      return null
    }
  }
}

async function loadNativeApi() {
  if (process.platform !== 'win32') return null
  const koffi = loadKoffi()
  if (koffi === null) return null
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const getFileSecurityW = advapi32.func(
    'int __stdcall GetFileSecurityW(const char16_t *path, uint32_t requested, void *descriptor, uint32_t length, _Out_ uint32_t *needed)',
  )
  const setFileSecurityW = advapi32.func(
    'int __stdcall SetFileSecurityW(const char16_t *path, uint32_t information, const void *descriptor)',
  )
  const replaceFileW = kernel32.func(
    'int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, const char16_t *backup, uint32_t flags, void *exclude, void *reserved)',
  )
  const getLastError = kernel32.func('uint32_t __stdcall GetLastError()')
  return { getFileSecurityW, setFileSecurityW, replaceFileW, getLastError }
}

async function nativeApi() {
  nativeApiPromise ??= loadNativeApi()
  return nativeApiPromise
}

/**
 * Official `dsh-fs-local` DACL copy: GetFileSecurityW of the source, then
 * SetFileSecurityW(PROTECTED_DACL | DACL) onto the empty staging file.
 */
export async function copyFileDaclWin32(source, destination) {
  const api = await nativeApi()
  if (api === null) {
    const error = new Error('SetFileSecurityW unavailable')
    error.code = 'EACCES'
    error.syscall = 'SetFileSecurityW'
    throw error
  }
  const nativeSource = toNamespacedPath(source)
  const needed = [0]
  api.getFileSecurityW(nativeSource, DACL_SECURITY_INFORMATION, null, 0, needed)
  if (needed[0] === 0) throw win32Error('GetFileSecurityW', api.getLastError(), source)
  const descriptor = Buffer.alloc(needed[0])
  if (api.getFileSecurityW(nativeSource, DACL_SECURITY_INFORMATION, descriptor, descriptor.length, needed) === 0) {
    throw win32Error('GetFileSecurityW', api.getLastError(), source)
  }
  if (api.setFileSecurityW(toNamespacedPath(destination), PROTECTED_DACL_AND_DACL, descriptor.subarray(0, needed[0])) === 0) {
    throw win32Error('SetFileSecurityW', api.getLastError(), destination)
  }
}

export async function replaceFileWin32(replaced, replacement) {
  const api = await nativeApi()
  if (api === null) {
    const error = new Error('ReplaceFileW unavailable')
    error.code = 'EACCES'
    error.syscall = 'ReplaceFileW'
    throw error
  }
  if (api.replaceFileW(toNamespacedPath(replaced), toNamespacedPath(replacement), null, 0, null, null) === 0) {
    throw win32Error('ReplaceFileW', api.getLastError(), replaced)
  }
}

/**
 * Call `primary`; on a Win32 ACL/replace permission failure, run `fallback`.
 * ENOENT is also retried: the official writer already treats a vanished
 * target as "publish via rename".
 */
export function withWin32Fallback(primary, fallback) {
  return async function fallbackCall(...args) {
    try {
      return await primary(...args)
    } catch (error) {
      if (!isWin32PermissionError(error) && error?.code !== 'ENOENT') throw error
      return fallback(...args)
    }
  }
}

async function swallowPermission(op) {
  try {
    await op()
  } catch (error) {
    if (!isWin32PermissionError(error)) throw error
  }
}

/**
 * Install the fallback onto a `LocalFileSystem.internals` object.
 * Returns a disposer that restores the previous hooks.
 */
export function installFallback(internals) {
  const previousCopy = internals.copyFileDacl
  const previousReplace = internals.replaceFile
  const copyFileDacl = async (source, destination) => {
    await swallowPermission(() => (previousCopy ?? copyFileDaclWin32)(source, destination))
  }
  const replaceFile = withWin32Fallback(
    (replaced, replacement) => (previousReplace ?? replaceFileWin32)(replaced, replacement),
    (replaced, replacement) => rename(replacement, replaced),
  )
  internals.copyFileDacl = copyFileDacl
  internals.replaceFile = replaceFile
  return () => {
    if (internals.copyFileDacl === copyFileDacl) {
      if (previousCopy === undefined) delete internals.copyFileDacl
      else internals.copyFileDacl = previousCopy
    }
    if (internals.replaceFile === replaceFile) {
      if (previousReplace === undefined) delete internals.replaceFile
      else internals.replaceFile = previousReplace
    }
  }
}

export function apply(ctx) {
  if (process.platform !== 'win32') return
  const fs = ctx.fs
  if (fs === undefined || fs.internals === undefined || typeof fs.internals !== 'object' || fs.internals === null) {
    return
  }
  ctx.effect(() => installFallback(fs.internals), 'win32-atomic-write-fallback: rename when WRITE_DAC is refused')
}
