/**
 * M1 smoke test for dsh-codex/tools/apply-patch.js — in-memory mock `ctx.fs`
 * covering resolve/stat/readText/writeText/delete/processPath/contains, so the
 * full parse → locate → mutate pipeline runs without touching the real disk.
 *
 * Usage: node dsh-codex/tools/apply-patch.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
const files = new Map() // absolute-ish path -> content
const dirs = new Set(['C:/tmp'])

function normJoin(base, p) {
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

const mockFs = {
  async resolve(path, opts = {}) {
    const abs = normJoin(opts.cwd ?? 'C:/tmp', path)
    return { targetKey: abs, displayPath: abs }
  },
  async stat(target) {
    if (files.has(target.targetKey)) return { version: 'v1', type: 'file', size: files.get(target.targetKey).length }
    if (dirs.has(target.targetKey)) return { version: 'v1', type: 'directory', size: 0 }
    return undefined
  },
  async readText(target) {
    if (!files.has(target.targetKey)) {
      const error = new Error(`file not found: ${target.displayPath}`)
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    return files.get(target.targetKey)
  },
  async writeText(target, content) {
    const existing = files.has(target.targetKey)
    files.set(target.targetKey, content)
    return { operation: existing ? 'update' : 'create', version: 'v2', before: null, after: content }
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
    // record every created directory, including parents
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
}

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  fs: mockFs,
}

const { apply } = await import('./apply-patch.js')
apply(ctx, {})

const tool = captured.find((t) => t.name === 'apply_patch')
assert.ok(tool, 'apply_patch registered')

const makeExec = () => ({
  agent: { session: { header: { cwd: 'C:/tmp' }, append() {} }, ctx: { effect: () => () => {} } },
  signal: new AbortController().signal,
  callId: 'call-1',
})
const run = (args, exec = makeExec()) => tool.execute(args, exec)

// ── Add + Update + Delete in one patch ─────────────────────────────────────
files.set('C:/tmp/existing.txt', 'old line\n')
files.set('C:/tmp/gone.txt', 'delete me\n')
const patch = [
  '*** Begin Patch',
  '*** Add File: new.txt',
  '+hello',
  '+world',
  '*** Update File: existing.txt',
  '@@',
  '-old line',
  '+new line',
  '*** Delete File: gone.txt',
  '*** End Patch',
].join('\n')

const value = await run({ patch })
assert.equal(value.summary, 'Success. Updated the following files:', 'summary')
assert.deepEqual(value.files, [
  { path: 'new.txt', action: 'A' },
  { path: 'existing.txt', action: 'M' },
  { path: 'gone.txt', action: 'D' },
], 'files list')
assert.equal(files.get('C:/tmp/new.txt'), 'hello\nworld\n', 'add content')
assert.equal(files.get('C:/tmp/existing.txt'), 'new line\n', 'update content')
assert.equal(files.has('C:/tmp/gone.txt'), false, 'delete removed file')

// ── render + presentCall ───────────────────────────────────────────────────
const text = tool.output.render({ patch }, value)[0].text
// codex HEAD shape: exec output shell + print_summary (apply-patch/src/lib.rs:764-780).
assert.equal(
  text,
  'Exit code: 0\nWall time: ' + String(Math.round(value.wall_time_seconds * 10) / 10) + ' seconds\nOutput:\nSuccess. Updated the following files:\nA new.txt\nM existing.txt\nD gone.txt\n',
  'render text'
)
const present = tool.presentCall({ patch })
assert.equal(present.title, 'Apply patch', 'presentCall title')
assert.equal(present.rawInput, patch, 'presentCall rawInput is the patch text')

// ── Move to (codex reports the destination) ────────────────────────────────
files.set('C:/tmp/src.txt', 'src content\n')
const moveValue = await run({
  patch: ['*** Begin Patch', '*** Update File: src.txt', '*** Move to: dst.txt', '@@', '-src content', '+dst content', '*** End Patch'].join('\n'),
})
assert.deepEqual(moveValue.files, [{ path: 'dst.txt', action: 'M' }], 'move reported at destination')
assert.equal(files.get('C:/tmp/dst.txt'), 'dst content\n', 'move destination content')
assert.equal(files.has('C:/tmp/src.txt'), false, 'move removed source')

// ── *** End of File append ─────────────────────────────────────────────────
files.set('C:/tmp/existing.txt', 'old line\n')
await run({
  patch: ['*** Begin Patch', '*** Update File: existing.txt', '@@', '+appended', '*** End of File', '*** End Patch'].join('\n'),
})
assert.equal(files.get('C:/tmp/existing.txt'), 'old line\nappended\n', 'end-of-file append')

// ── multi-chunk update with context headers ────────────────────────────────
files.set(
  'C:/tmp/config.rs',
  [
    'fn default() {',
    '    pub apply_patch_progress: bool,',
    '    pub include_diagnostics: bool,',
    '    Duration::from_millis(500)',
    '}',
    '',
  ].join('\n')
)
await run({
  patch: [
    '*** Begin Patch',
    '*** Update File: config.rs',
    '@@ fn default() {',
    '-    pub apply_patch_progress: bool,',
    '+    pub stream_apply_patch_progress: bool,',
    '     pub include_diagnostics: bool,', // context marker + 4-space original line
    '@@',
    '-    Duration::from_millis(500)',
    '+    Duration::from_millis(250)',
    '*** End Patch',
  ].join('\n'),
})
assert.equal(
  files.get('C:/tmp/config.rs'),
  [
    'fn default() {',
    '    pub stream_apply_patch_progress: bool,',
    '    pub include_diagnostics: bool,',
    '    Duration::from_millis(250)',
    '}',
    '',
  ].join('\n'),
  'multi-chunk update applied in order'
)

// ── parse error: missing End Patch ─────────────────────────────────────────
await assert.rejects(
  () => run({ patch: '*** Begin Patch\n*** Add File: x.txt\n+x\n' }),
  /apply_patch verification failed: invalid patch: The last line of the patch must be '\*\*\* End Patch'/,
  'missing end marker errors'
)

// ── parse error: bad line in update hunk carries a line number ─────────────
await assert.rejects(
  () => run({ patch: '*** Begin Patch\n*** Update File: existing.txt\n@@\n-old\nbad line\n*** End Patch' }),
  /apply_patch verification failed: invalid hunk at line 5, Expected update hunk to start with a @@ context marker/,
  'line-numbered hunk error'
)

// ── context not found in update ────────────────────────────────────────────
files.set('C:/tmp/existing.txt', 'some content\n')
await assert.rejects(
  () => run({ patch: '*** Begin Patch\n*** Update File: existing.txt\n@@ missing\n-old\n+new\n*** End Patch' }),
  /Failed to find context 'missing' in C:\/tmp\/existing.txt/,
  'missing context errors'
)

// ── Add File into a missing parent directory auto-creates it (codex parity) ─
const created = await run({ patch: '*** Begin Patch\n*** Add File: nodir/file.txt\n+x\n*** End Patch' })
assert.equal(created.files[0].action, 'A', 'add into auto-created parent succeeds')
assert.equal(files.get('C:/tmp/nodir/file.txt'), 'x\n', 'content written under created parent')
assert.ok(dirs.has('C:/tmp/nodir'), 'parent directory recorded as created')

// ── delete outside the working directory is rejected ───────────────────────
await assert.rejects(
  () => run({ patch: '*** Begin Patch\n*** Delete File: C:/elsewhere/evil.txt\n*** End Patch' }),
  /refusing to delete C:\/elsewhere\/evil.txt: it resolves outside the working directory/,
  'out-of-cwd delete rejected'
)

// ── empty patch (no hunks) ─────────────────────────────────────────────────
await assert.rejects(
  () => run({ patch: '*** Begin Patch\n*** End Patch' }),
  /patch rejected: empty patch/,
  'empty patch errors'
)

// ── requires an owning agent session ───────────────────────────────────────
await assert.rejects(
  () => tool.execute({ patch }, { signal: new AbortController().signal }),
  /apply_patch requires an owning agent session/,
  'agent required'
)

console.log('apply-patch smoke test: ALL PASS')
