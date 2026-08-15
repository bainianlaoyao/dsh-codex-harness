/**
 * dsh-codex M1 — `apply_patch` freeform file editor.
 *
 * Codex-parity patch language (HEAD 5bc8da6d78, apply_patch.lark +
 * codex-rs/apply-patch/src/{parser,streaming_parser,file_update,seek_sequence}.rs)
 * re-implemented in JS over the DSH `ctx.fs` seam: Add/Update/Delete/Move hunks
 * with @@-separated chunks, context/old-line seeking, end-of-file pinning, and
 * codex's always-active lenient `<<EOF` heredoc stripping. Missing parent
 * directories are created recursively (codex
 * write_file_with_missing_parent_retry).
 *
 * FREEFORM fidelity: the tool description is codex's verbatim string
 * (codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20). On the
 * `openai-responses` LLM route (dsh-codex/llm-responses.js) apply_patch is
 * declared as a Responses `custom` tool with codex's lark grammar, so the
 * model emits the raw patch text with no JSON wrapper — the adapter converts
 * it to the harness's internal `{patch: ...}` arguments transport. On the
 * chat-completions route (llm-openai.js) the same schema degrades to a JSON
 * function call (chat-completions has no custom-tool type).
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
const CTX = '@@ '
const INVALID_HEADER = (l) =>
  `'${l}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
const UNEXPECTED = (l) =>
  `Unexpected line found in update hunk: '${l}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`
const hunkErr = (at, message) => new Error(`invalid hunk at line ${at}, ${message}`)
const patchErr = (message) => new Error(`invalid patch: ${message}`)

/**
 * Parse a patch into hunks (`{kind:'add',path,contents}`, `{kind:'delete',path}`,
 * `{kind:'update',path,movePath,chunks}`), porting the codex StreamingPatchParser
 * state machine with its messages and line numbers.
 * @param {string} patchText - raw freeform patch argument.
 * @returns {object[]} parsed hunks.
 */
function parsePatch(patchText) {
  let lines = patchText.trim().split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
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
    if (empty(lastChunk(h))) throw hunkErr(at, line === END ? 'Update hunk does not contain any lines' : UNEXPECTED(line))
  }
  const headerOrEnd = (line, at) => {
    if (line === END) { ensure(line, at); mode = 'ended'; return true }
    if (line.startsWith(ADD)) { ensure(line, at); hunks.push({ kind: 'add', path: line.slice(ADD.length), contents: [] }); mode = 'add'; return true }
    if (line.startsWith(DEL)) { ensure(line, at); hunks.push({ kind: 'delete', path: line.slice(DEL.length) }); mode = 'delete'; return true }
    if (line.startsWith(UPD)) { ensure(line, at); hunks.push({ kind: 'update', path: line.slice(UPD.length), movePath: null, chunks: [] }); mode = 'update'; updateAt = at; return true }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const at = i + 1
    if (mode === 'not-started') {
      if (trimmed === BEGIN) { mode = 'started'; continue }
      throw patchErr("The first line of the patch must be '*** Begin Patch'")
    }
    if (mode === 'started' || mode === 'add' || mode === 'delete') {
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
        if (empty(lastChunk(h))) throw hunkErr(at, 'Update hunk does not contain any lines')
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
  return hunks
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
 */
function computeReplacements(lines, path, chunks) {
  const out = []
  let index = 0
  for (const c of chunks) {
    if (c.changeContext !== null) {
      const at = seekSequence(lines, [c.changeContext], index, false)
      if (at === null) throw new Error(`Failed to find context '${c.changeContext}' in ${path}`)
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
    if (at === null) throw new Error(`Failed to find expected lines in ${path}:\n${c.oldLines.join('\n')}`)
    out.push([at, pattern.length, [...fresh]])
    index = at + pattern.length
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Derive new file contents after applying `chunks` (NormalizeToLf mode). */
function deriveNewContents(original, path, chunks) {
  const lines = original.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const replacements = computeReplacements(lines, path, chunks)
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
 * Create the target's parent directories when missing (codex
 * write_file_with_missing_parent_retry, apply-patch/src/lib.rs:726-740 —
 * recursive create). The dsh FileSystem has no directory primitive, so the
 * directory itself is created on the backend's processPath; the subsequent
 * writeText still goes through ctx.fs and its sandbox policy.
 */
async function ensureParentDirectory(ctx, target, cwd) {
  const parent = await ctx.fs.resolve(parentDir(target.displayPath), { cwd })
  const info = await ctx.fs.stat(parent)
  if (info !== undefined) {
    if (info.type !== 'directory') throw new Error(`Failed to write file ${target.displayPath}: a non-directory exists at its parent path`)
    return
  }
  // Backend-provided primitive when present (testable without touching the
  // real filesystem); the shipped backends expose none, so fall back to
  // node mkdir on the backend's processPath.
  if (typeof ctx.fs.mkdir === 'function') {
    await ctx.fs.mkdir(parent, { recursive: true })
    return
  }
  await mkdir(ctx.fs.processPath(parent), { recursive: true })
}

/** Remove a target via the backend `delete` when present, else fs.rm (caller containment-checked). */
async function removeTarget(ctx, target) {
  if (typeof ctx.fs.delete === 'function') return ctx.fs.delete(target)
  await rm(ctx.fs.processPath(target), { recursive: false, force: false })
}

/** Apply parsed hunks in order through ctx.fs; returns [{path, action}]. */
async function applyHunks(ctx, hunks, cwd) {
  const files = []
  const cwdTarget = await ctx.fs.resolve(cwd, { cwd })
  for (const hunk of hunks) {
    if (hunk.kind === 'add') {
      const target = await ctx.fs.resolve(hunk.path, { cwd })
      await ensureParentDirectory(ctx, target, cwd)
      await ctx.fs.writeText(target, hunk.contents.map((line) => `${line}\n`).join(''))
      files.push({ path: hunk.path, action: 'A' })
    } else if (hunk.kind === 'delete') {
      const target = await ctx.fs.resolve(hunk.path, { cwd })
      assertContained(ctx, cwdTarget, target, hunk.path)
      const info = await ctx.fs.stat(target)
      if (info === undefined) throw new Error(`Failed to delete file ${hunk.path}: file does not exist`)
      if (info.type !== 'file') throw new Error(`Failed to delete file ${hunk.path}: not a regular file`)
      await removeTarget(ctx, target)
      files.push({ path: hunk.path, action: 'D' })
    } else {
      const target = await ctx.fs.resolve(hunk.path, { cwd })
      const info = await ctx.fs.stat(target)
      if (info === undefined) throw new Error(`Failed to read file to update ${hunk.path}: file does not exist`)
      if (info.type !== 'file') throw new Error(`Failed to update ${hunk.path}: not a regular file`)
      const newContent = deriveNewContents(await ctx.fs.readText(target), hunk.path, hunk.chunks)
      if (hunk.movePath !== null) {
        // codex reports the move DESTINATION in the summary (Hunk::path()).
        const dest = await ctx.fs.resolve(hunk.movePath, { cwd })
        await ensureParentDirectory(ctx, dest, cwd)
        await ctx.fs.writeText(dest, newContent)
        await removeTarget(ctx, target)
        files.push({ path: hunk.movePath, action: 'M' })
      } else {
        await ctx.fs.writeText(target, newContent)
        files.push({ path: hunk.path, action: 'M' })
      }
    }
  }
  return files
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
            summary: { type: 'string', required: true },
            wall_time_seconds: { type: 'number', required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  action: { type: 'string', required: true },
                },
              },
            },
          },
        },
        // codex HEAD shape: the apply_patch CLI result is wrapped in the exec
        // output shell (Exit code / Wall time / Output:) and the summary is
        // print_summary() (apply-patch/src/lib.rs:764-780):
        // "Success. Updated the following files:" + A/M/D lines with the
        // patch's own path spellings.
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              'Exit code: 0',
              `Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`,
              'Output:',
              value.summary,
              ...value.files.map((f) => `${f.action} ${f.path}`),
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        if (typeof args.patch !== 'string' || args.patch.trim().length === 0) {
          throw new Error('apply_patch: patch must be a non-empty string')
        }
        let hunks
        try {
          hunks = parsePatch(args.patch)
        } catch (error) {
          throw new Error(`apply_patch verification failed: ${error.message}`)
        }
        if (hunks.length === 0) throw new Error('apply_patch: No files were modified.')
        const agent = exec.agent
        if (agent === undefined) throw new Error('apply_patch requires an owning agent session')
        const cwd = agent.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw new Error('apply_patch: no working directory on the owning agent session')
        }
        const start = Date.now()
        let files
        try {
          files = await applyHunks(ctx, hunks, cwd)
        } catch (error) {
          // codex wraps every apply_patch failure (parse AND verification) in
          // "apply_patch verification failed: …" (apply_patch_cli.rs asserts
          // the prefix on missing-context / missing-file / delete-missing).
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
      },
      presentCall: (args) => ({ card: 'generic', title: 'Apply patch', kind: 'other', rawInput: args.patch }),
    })
  )
}
