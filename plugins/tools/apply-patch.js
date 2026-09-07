/**
 * dsh-codex M1 — `apply_patch` freeform file editor.
 *
 * Codex-parity patch language (rust-v0.153.4, apply_patch.lark +
 * codex-rs/apply-patch/src/{parser,streaming_parser,file_update,seek_sequence,
 * invocation,lib}.rs) re-implemented in JS over the DSH `ctx.fs` seam:
 * Add/Update/Delete/Move hunks with @@-separated chunks, context/old-line
 * seeking, end-of-file pinning, the `*** Environment ID:` marker (parsed and
 * validated, then ignored — this deployment has one environment), and codex's
 * always-active lenient `<<EOF` heredoc stripping.
 *
 * Handler semantics (core/src/tools/handlers/apply_patch.rs):
 * - parse errors and verification errors are wrapped in
 *   "apply_patch verification failed: {err}";
 * - the whole patch is VERIFIED against the filesystem before anything is
 *   written (try_verify_apply_patch_args) — a failing patch has no side
 *   effects; verification rejects duplicate resolved paths with
 *   "invalid patch: multiple operations target {abs}";
 * - all file errors carry the resolved ABSOLUTE native path and the Rust io
 *   error spelling ("No such file or directory (os error 2)" for ENOENT);
 * - safety rejections ("empty patch") surface as "patch rejected: empty
 *   patch" WITHOUT the verification prefix (safety.rs assess_patch_safety);
 * - success renders the exec-shell wrapper of the standalone:
 *   "Exit code: 0 / Wall time: {1-decimal} seconds / Output:" +
 *   print_summary "Success. Updated the following files:" + A/M/D lines
 *   grouped added → modified → deleted (lib.rs print_summary + tools/mod.rs
 *   format_exec_output_for_model: wall time rounded to 1 decimal).
 * - unsandboxed apply (this deployment) rejects symlink leaves and ancestors
 *   via ctx.fs.lstat (`follow_symlinks: false`, Codex #39659).
 *
 * @module dsh-codex/tools/apply-patch
 */

import { mkdir, rm } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-codex-apply-patch'
export const inject = ['tools', 'fs']

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DEL = '*** Delete File: '
const UPD = '*** Update File: '
const MOVE = '*** Move to: '
const EOF_LINE = '*** End of File'
const ENV_ID = '*** Environment ID:'
const CTX = '@@ '
const INVALID_HEADER = (l) =>
  `'${l}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
const UNEXPECTED = (l) =>
  `Unexpected line found in update hunk: '${l}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`
const hunkErr = (at, message) => new Error(`invalid hunk at line ${at}, ${message}`)
const patchErr = (message) => new Error(`invalid patch: ${message}`)

/**
 * Parse a patch into hunks, porting the codex StreamingPatchParser state
 * machine with its messages and line numbers. The parser also accepts the
 * "*** Environment ID: {id}" marker after the Begin Patch header
 * (streaming_parser.rs:84-101): at most once, non-empty.
 * @returns {{ hunks: object[], environmentId: string|null }}
 */
export function parsePatch(patchText) {
  let lines = patchText.trim().split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const first = lines[0]?.trim()
  const last = lines[lines.length - 1]?.trim()
  if (first !== BEGIN || last !== END) {
    // Lenient heredoc form (codex PARSE_IN_STRICT_MODE is always false).
    if (
      lines.length >= 4 &&
      (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
      last.endsWith('EOF') &&
      lines[1].trim() === BEGIN &&
      lines[lines.length - 2].trim() === END
    ) {
      lines = lines.slice(1, -1)
    } else if (first !== BEGIN) {
      throw patchErr("The first line of the patch must be '*** Begin Patch'")
    } else {
      throw patchErr("The last line of the patch must be '*** End Patch'")
    }
  }

  const hunks = []
  let mode = 'not-started'
  let updateAt = 0
  let environmentId = null
  const lastChunk = (h) => h.chunks[h.chunks.length - 1]
  const empty = (c) => c !== undefined && c.oldLines.length === 0 && c.newLines.length === 0
  const chunk = (context) => ({ changeContext: context, oldLines: [], newLines: [], isEndOfFile: false })
  const pushChunk = (h, context) => {
    if (h.chunks.length === 0) h.chunks.push(chunk(context))
    return lastChunk(h)
  }
  const ensure = (line, at) => {
    const h = hunks[hunks.length - 1]
    if (!h || h.kind !== 'update') return
    if (h.chunks.length === 0 && mode === 'update') throw hunkErr(updateAt, `Update file hunk for path '${h.path}' is empty`)
    if (empty(lastChunk(h))) throw hunkErr(at, line === END ? "Update hunk does not contain any lines" : UNEXPECTED(line))
  }
  const headerOrEnd = (line, at) => {
    if (line === END) { ensure(line, at); mode = "ended"; return true }
    if (line.startsWith(ADD)) { ensure(line, at); hunks.push({ kind: 'add', path: line.slice(ADD.length), contents: [] }); mode = 'add'; return true }
    if (line.startsWith(DEL)) { ensure(line, at); hunks.push({ kind: 'delete', path: line.slice(DEL.length) }); mode = 'delete'; return true }
    if (line.startsWith(UPD)) { ensure(line, at); hunks.push({ kind: 'update', path: line.slice(UPD.length), movePath: null, chunks: [] }); mode = 'update'; updateAt = at; return true }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const at = i + 1
    // codex finish() accepts the final line as the End marker after trimming,
    // so surrounding whitespace on "*** End Patch" is tolerated (scenario 020).
    if (i === lines.length - 1 && trimmed === END) {
      ensure(trimmed, at)
      mode = "ended"
      continue
    }
    if (mode === 'not-started') {
      if (trimmed === BEGIN) { mode = "started"; continue }
      throw patchErr("The first line of the patch must be '*** Begin Patch'")
    }
    if (mode === 'started' || mode === 'add' || mode === 'delete') {
      if (trimmed.startsWith(ENV_ID)) {
        // *** Environment ID: {id} — at most once, non-empty (streaming_parser.rs:84-101).
        if (environmentId !== null) throw patchErr("apply_patch environment_id cannot be specified more than once")
        const id = trimmed.slice(ENV_ID.length).trim()
        if (id === "") throw patchErr("apply_patch environment_id cannot be empty")
        environmentId = id
        continue
      }
      if (headerOrEnd(trimmed, at)) continue
      if (mode === 'add' && raw.startsWith('+')) {
        hunks[hunks.length - 1].contents.push(raw.slice(1))
        continue
      }
      throw hunkErr(at, INVALID_HEADER(trimmed))
    }
    if (mode === 'update') {
      const line = raw.trimEnd()
      const h = hunks[hunks.length - 1]
      if (headerOrEnd(line, at)) continue
      if (lastChunk(h)?.isEndOfFile) {
        if (line === '') continue
        if (line !== '@@' && !line.startsWith(CTX)) throw hunkErr(at, `Expected update hunk to start with a @@ context marker, got: '${raw}'`)
      }
      if (h.chunks.length === 0 && h.movePath === null && line.startsWith(MOVE)) { h.movePath = line.slice(MOVE.length); continue }
      if ((line === '@@' || line.startsWith(CTX)) && empty(lastChunk(h))) throw hunkErr(at, UNEXPECTED(raw))
      if (line === '@@') { h.chunks.push(chunk(null)); continue }
      if (line.startsWith(CTX)) { h.chunks.push(chunk(line.slice(CTX.length))); continue }
      if (line === EOF_LINE) {
        if (empty(lastChunk(h))) throw hunkErr(at, "Update hunk does not contain any lines")
        lastChunk(h).isEndOfFile = true
        continue
      }
      if (raw === '') { const c = pushChunk(h, null); c.oldLines.push(''); c.newLines.push(''); continue }
      if (raw.startsWith(' ')) { const c = pushChunk(h, null); c.oldLines.push(raw.slice(1)); c.newLines.push(raw.slice(1)); continue }
      if (raw.startsWith('+')) { pushChunk(h, null).newLines.push(raw.slice(1)); continue }
      if (raw.startsWith('-')) { pushChunk(h, null).oldLines.push(raw.slice(1)); continue }
      if (!empty(lastChunk(h))) throw hunkErr(at, `Expected update hunk to start with a @@ context marker, got: '${raw}'`)
      throw hunkErr(at, UNEXPECTED(raw))
    }
    if (trimmed === '') continue
    throw patchErr("The last line of the patch must be '*** End Patch'")
  }
  if (mode !== 'ended') throw patchErr("The last line of the patch must be '*** End Patch'")
  return { hunks, environmentId }
}

/** codex seek_sequence::normalise — common Unicode punctuation → ASCII. */
function normalise(text) {
  let out = ''
  for (const ch of text.trim()) {
    const c = ch.codePointAt(0)
    out +=
      (c >= 0x2010 && c <= 0x2015) || c === 0x2212
        ? '-'
        : c >= 0x2018 && c <= 0x201b
          ? "'"
          : c >= 0x201c && c <= 0x201f
            ? '"'
            : c === 0xa0 || (c >= 0x2002 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000
              ? ' '
              : ch
  }
  return out
}

/**
 * Locate `pattern` in `lines` at/after `start` with codex's decreasing
 * strictness; with `eof` the search starts at end-of-file (NormalizeToLf).
 * @returns {number|null} match start index.
 */
function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return null
  const from = eof ? lines.length - pattern.length : start
  const last = lines.length - pattern.length
  const find = (pred) => {
    for (let i = from; i <= last; i++) {
      let ok = true
      for (let p = 0; p < pattern.length && ok; p++) ok = pred(lines[i + p], pattern[p])
      if (ok) return i
    }
    return null
  }
  return (
    find((a, b) => a === b) ??
    find((a, b) => a.trimEnd() === b.trimEnd()) ??
    find((a, b) => a.trim() === b.trim()) ??
    find((a, b) => normalise(a) === normalise(b))
  )
}

/**
 * Compute `[start, oldLen, newLines]` replacements for one file's chunks
 * (codex file_update::compute_replacements, NormalizeToLf: pure insertions
 * append at end-of-file, before the trailing '' sentinel when present).
 * `displayPath` is the resolved absolute native path used in errors.
 */
function computeReplacements(lines, displayPath, chunks) {
  const out = []
  let index = 0
  for (const c of chunks) {
    if (c.changeContext !== null) {
      const at = seekSequence(lines, [c.changeContext], index, false)
      if (at === null) throw new Error(`Failed to find context '${c.changeContext}' in ${displayPath}`)
      index = at + 1
    }
    if (c.oldLines.length === 0) {
      const at = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      out.push([at, 0, [...c.newLines]])
      continue
    }
    let pattern = c.oldLines
    let fresh = c.newLines
    let at = seekSequence(lines, pattern, index, c.isEndOfFile)
    if (at === null && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (fresh[fresh.length - 1] === '') fresh = fresh.slice(0, -1)
      at = seekSequence(lines, pattern, index, c.isEndOfFile)
    }
    if (at === null) throw new Error(`Failed to find expected lines in ${displayPath}:\n${c.oldLines.join('\n')}`)
    out.push([at, pattern.length, [...fresh]])
    index = at + pattern.length
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Derive new file contents after applying `chunks` (NormalizeToLf mode). */
function deriveNewContents(original, displayPath, chunks) {
  const lines = original.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const replacements = computeReplacements(lines, displayPath, chunks)
  for (let r = replacements.length - 1; r >= 0; r--) {
    const [at, len, fresh] = replacements[r]
    lines.splice(at, Math.min(len, Math.max(0, lines.length - at)))
    lines.splice(at, 0, ...fresh)
  }
  if (lines[lines.length - 1] !== '') lines.push('')
  return lines.join('\n')
}

const parentDir = (path) => {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.length === 0 ? '.' : parts.join('/')
}

/** Reject deletes of paths resolving outside the session cwd (no sandboxed delete exists). */
function assertContained(ctx, cwdTarget, target, patchPath) {
  if (!ctx.fs.contains(cwdTarget, target)) {
    throw new Error(`apply_patch: refusing to delete ${patchPath}: it resolves outside the working directory`)
  }
}

/**
 * Prefixes of a patch path, from the first component to the full path.
 * Used with `lstat` so ancestor and leaf symlinks are both visible
 * (DSH `lstat` does not follow only the final component).
 */
export function pathPrefixes(patchPath) {
  if (typeof patchPath !== 'string' || patchPath.trim().length === 0) return []
  const unix = patchPath.replace(/\\/g, '/')
  const parts = unix.split('/')
  const out = []
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    if (seg === '.' || (seg === '' && i !== 0)) continue
    if (i === 0 && /^[A-Za-z]:$/.test(seg)) {
      acc = seg
      continue
    }
    if (seg === '' && i === 0) {
      acc = ''
      continue
    }
    acc = acc === '' ? (unix.startsWith('/') ? `/${seg}` : seg) : `${acc}/${seg}`
    if (acc === '/' || acc === '') continue
    out.push(acc)
  }
  return out
}

/**
 * Codex `#39659` no-follow: reject a patch path when any component is a
 * symlink. This deployment runs unsandboxed (`danger-full-access`), which
 * is the Codex path that sets `follow_symlinks: false`.
 *
 * Uses `ctx.fs.lstat` (path-shaped, does not follow the final component)
 * on every prefix so ancestor links are caught too. Absent prefixes are
 * allowed (Add File into a missing directory).
 */
async function assertNoSymlinks(ctx, patchPath, cwd) {
  if (typeof ctx.fs.lstat !== 'function') return
  for (const prefix of pathPrefixes(patchPath)) {
    let info
    try {
      info = await ctx.fs.lstat(prefix, { cwd })
    } catch (error) {
      throw new Error(`${patchPath}: ${ioErrorText(error)}`)
    }
    if (info === undefined) continue
    if (info.type === 'symlink' || info.type === 'other') {
      throw new Error(`path contains a symbolic link: ${prefix}`)
    }
  }
}

/** Rust io::Error Display for common Node error codes (ENOENT first). */
function ioErrorText(error) {
  if (error?.code === 'ENOENT') return 'No such file or directory (os error 2)'
  if (error?.code === 'EACCES') return 'Permission denied (os error 13)'
  if (error?.code === 'EISDIR') return 'Is a directory (os error 21)'
  if (error?.code === 'ENOTDIR') return 'Not a directory (os error 20)'
  if (error?.code === 'EEXIST') return 'File exists (os error 17)'
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one hunk target to an absolute native path (Hunk::resolve_path):
 * returns the fs target and its display path (native absolute), or throws
 * the official resolution error.
 */
async function resolveTarget(ctx, patchPath, cwd) {
  const target = await ctx.fs.resolve(patchPath, { cwd })
  return { target, displayPath: target.displayPath ?? target.path ?? patchPath }
}

/**
 * Verification stage (try_verify_apply_patch_args + unified_diff_from_chunks):
 * resolves and reads every hunk WITHOUT writing, rejects duplicate resolved
 * paths, and derives the new contents. A failure here leaves no side
 * effects on the filesystem.
 * @returns {object[]} verified operations [{kind, target, displayPath, newContent?}]
 */
async function verifyHunks(ctx, hunks, cwd) {
  const cwdTarget = await ctx.fs.resolve(cwd, { cwd })
  const seen = new Map()
  const ops = []
  for (const hunk of hunks) {
    await assertNoSymlinks(ctx, hunk.path, cwd)
    if (hunk.movePath !== null && hunk.movePath !== undefined) await assertNoSymlinks(ctx, hunk.movePath, cwd)
    const { target, displayPath } = await resolveTarget(ctx, hunk.path, cwd)
    const key = displayPath
    if (seen.has(key)) throw new Error(`invalid patch: multiple operations target ${key}`)
    seen.set(key, true)
    if (hunk.kind === "add") {
      ops.push({ kind: "add", target, displayPath, rawPath: hunk.path, checkPath: hunk.path, contents: hunk.contents })
      continue
    }
    if (hunk.kind === "delete") {
      assertContained(ctx, cwdTarget, target, hunk.path)
      // codex verifies a delete by READING the target (invocation.rs:246-253):
      // a directory therefore fails here with "Failed to read ... Is a directory".
      try {
        await ctx.fs.readText(target)
      } catch (error) {
        throw new Error(`Failed to read ${displayPath}: ${ioErrorText(error)}`)
      }
      ops.push({ kind: "delete", target, displayPath, rawPath: hunk.path, checkPath: hunk.path })
      continue
    }
    // update (and move)
    let info
    try {
      info = await ctx.fs.stat(target)
    } catch (error) {
      throw new Error(`Failed to read file to update ${displayPath}: ${ioErrorText(error)}`)
    }
    if (info === undefined) throw new Error(`Failed to read file to update ${displayPath}: No such file or directory (os error 2)`)
    let original
    try {
      original = await ctx.fs.readText(target)
    } catch (error) {
      throw new Error(`Failed to read file to update ${displayPath}: ${ioErrorText(error)}`)
    }
    let newContent
    try {
      newContent = deriveNewContents(original, displayPath, hunk.chunks)
    } catch (error) {
      throw error; // Failed to find context / expected lines — already official text
    }
    if (hunk.movePath !== null) {
      const dest = await resolveTarget(ctx, hunk.movePath, cwd)
      if (dest.displayPath !== key) {
        if (seen.has(dest.displayPath)) throw new Error(`invalid patch: multiple operations target ${dest.displayPath}`)
        seen.set(dest.displayPath, true)
      }
      ops.push({ kind: "update", target, displayPath, rawPath: hunk.movePath, checkPath: hunk.path, newContent, moveTo: { ...dest, checkPath: hunk.movePath } })
    } else {
      ops.push({ kind: "update", target, displayPath, rawPath: hunk.path, checkPath: hunk.path, newContent })
    }
  }
  return ops
}

/**
 * Create the target's parent directories when missing (codex
 * write_file_with_missing_parent_retry, apply-patch/src/lib.rs:726-740).
 */
async function ensureParentDirectory(ctx, target, cwd) {
  const parent = await ctx.fs.resolve(parentDir(target.displayPath), { cwd })
  const info = await ctx.fs.stat(parent)
  if (info !== undefined) {
    if (info.type !== 'directory') throw new Error(`Failed to write file ${target.displayPath}: a non-directory exists at its parent path`)
    return
  }
  if (typeof ctx.fs.mkdir === "function") {
    await ctx.fs.mkdir(parent, { recursive: true })
    return
  }
  await mkdir(ctx.fs.processPath(parent), { recursive: true })
}

/** Remove a target via the backend `delete` when present, else fs.rm. */
async function removeTarget(ctx, target) {
  if (typeof ctx.fs.delete === "function") return ctx.fs.delete(target)
  await rm(ctx.fs.processPath(target), { recursive: false, force: false })
}

/** Apply verified operations through ctx.fs; returns [{path, action}]. */
async function applyOps(ctx, ops, cwd) {
  const files = []
  for (const op of ops) {
    await assertNoSymlinks(ctx, op.checkPath, cwd)
    if (op.moveTo !== undefined) await assertNoSymlinks(ctx, op.moveTo.checkPath, cwd)
    if (op.kind === "add") {
      await ensureParentDirectory(ctx, op.target, cwd)
      await ctx.fs.writeText(op.target, op.contents.map((line) => `${line}\n`).join(""))
      files.push({ path: op.rawPath, action: "A" })
    } else if (op.kind === "delete") {
      await removeTarget(ctx, op.target)
      files.push({ path: op.rawPath, action: "D" })
    } else {
      if (op.moveTo !== undefined) {
        // codex reports the move DESTINATION in the summary (Hunk::path()).
        await ensureParentDirectory(ctx, op.moveTo.target, cwd)
        await ctx.fs.writeText(op.moveTo.target, op.newContent)
        await removeTarget(ctx, op.target)
        files.push({ path: op.rawPath, action: "M" })
      } else {
        await ctx.fs.writeText(op.target, op.newContent)
        files.push({ path: op.rawPath, action: "M" })
      }
    }
  }
  return files
}

/** codex tools/mod.rs format_exec_output_for_model: wall time rounded to 1 decimal. */
function formatWallTime(seconds) {
  const rounded = Math.round(seconds * 10) / 10
  return String(rounded)
}

/** Model-facing apply_patch success text (exec-shell wrapper + print_summary). */
export function formatApplyPatchOutput(value) {
  return [
    'Exit code: 0',
    `Wall time: ${formatWallTime(value.wall_time_seconds)} seconds`,
    'Output:',
    value.summary,
    ...value.files.map((file) => `${file.action} ${file.path}`),
  ].join('\n') + '\n'
}

/**
 * Parse, verify, and apply a patch against `cwd`. Shared by the `apply_patch`
 * tool and by `exec_command` interception of an embedded apply_patch invocation.
 */
export async function applyPatchText(ctx, patch, cwd) {
  let parsed
  try {
    parsed = parsePatch(patch)
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error.message}`)
  }
  // Safety assessment (safety.rs): an empty patch is rejected WITHOUT
  // the verification prefix.
  if (parsed.hunks.length === 0) {
    throw new Error('patch rejected: empty patch')
  }
  const start = Date.now()
  // Verification stage first: any failure leaves the filesystem untouched.
  let ops, files
  try {
    ops = await verifyHunks(ctx, parsed.hunks, cwd)
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error.message}`)
  }
  try {
    files = await applyOps(ctx, ops, cwd)
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error.message}`)
  }
  // print_summary groups by action: added → modified → deleted
  // (apply-patch/src/lib.rs:764-780), stable within each group.
  const ACTION_ORDER = { A: 0, M: 1, D: 2 }
  files.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action])
  return {
    summary: 'Success. Updated the following files:',
    wall_time_seconds: (Date.now() - start) / 1000,
    files,
  }
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'apply_patch',
      description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
      parameters: {
        patch: {
          type: 'string',
          required: true,
          description:
            "The patch text in the apply_patch format ('*** Begin Patch' ... '*** End Patch'; Add/Update/Delete File hunks, @@-separated chunks with '-', '+', ' ' lines, '*** Move to:' for moves, '*** End of File' pinning).",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: "string", required: true },
            wall_time_seconds: { type: "number", required: true },
            files: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  action: { type: "string", required: true },
                },
              },
            },
          },
        },
        // codex HEAD shape: the apply_patch CLI result is wrapped in the exec
        // output shell (format_exec_output_for_model: "Exit code: 0" /
        // "Wall time: {1-decimal} seconds" / "Output:") and the summary is
        // print_summary() (apply-patch/src/lib.rs:764-780):
        // "Success. Updated the following files:" + A/M/D lines.
        render: (_args, value) => [{ type: "text", text: formatApplyPatchOutput(value) }],
      },
      async execute(args, exec) {
        if (typeof args.patch !== 'string' || args.patch.trim().length === 0) {
          throw new Error('apply_patch: patch must be a non-empty string')
        }
        const agent = exec.agent
        if (agent === undefined) throw new Error('apply_patch requires an owning agent session')
        const cwd = agent.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw new Error('apply_patch: no working directory on the owning agent session')
        }
        return applyPatchText(ctx, args.patch, cwd)
      },
      presentCall: (args) => ({ card: 'generic', title: 'Apply patch', kind: 'other', rawInput: args.patch }),
    })
  )
}