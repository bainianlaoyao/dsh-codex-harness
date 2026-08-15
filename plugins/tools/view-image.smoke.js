/**
 * M1 smoke test for dsh-codex/tools/view-image.js — in-memory mock `ctx.fs`
 * serving raw bytes, exercising magic-number detection, the official codex
 * error strings, and the octet-stream data URL.
 *
 * Usage: node dsh-codex/tools/view-image.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
const blobs = new Map() // path -> Uint8Array

function normJoin(base, p) {
  const isAbs = /^[A-Za-z]:/.test(p) || p.startsWith('/')
  const raw = isAbs ? p : `${base}/${p}`
  return raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.$/, '')
}

const mockFs = {
  async resolve(path, opts = {}) {
    if (path.startsWith('bad/')) {
      const error = new Error('EACCES: permission denied')
      throw error
    }
    const abs = normJoin(opts.cwd ?? 'C:/tmp', path)
    return { targetKey: abs, displayPath: abs }
  },
  async readBytes(target, signal, maxBytes) {
    if (target.targetKey.startsWith('C:/tmp/dir')) {
      const error = new Error(`cannot read "${target.displayPath}": not a regular file`)
      error.code = 'FS_NOT_REGULAR_FILE'
      throw error
    }
    if (target.targetKey.startsWith('C:/tmp/locked')) {
      const error = new Error(`cannot read "${target.displayPath}": EACCES: permission denied`)
      error.code = 'EACCES'
      throw error
    }
    const bytes = blobs.get(target.targetKey)
    if (bytes === undefined) {
      const error = new Error(`file not found: ${target.displayPath}`)
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    if (bytes.byteLength > maxBytes) {
      const error = new Error(`file too large: ${bytes.byteLength} > ${maxBytes}`)
      error.code = 'FS_TOO_LARGE'
      throw error
    }
    return bytes
  },
}

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  fs: mockFs,
  get(service) {
    if (service === 'attachments')
      return {
        imageLimits: { maxImageBytes: 200 * 1024, maxMessageImageBytes: 200 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
        async saveImage({ data, mediaType, name }) {
          const ref = { attachmentId: `att-${savedImages.length + 1}`, mediaType, bytes: data.byteLength, width: 1, height: 1, ...(name === undefined ? {} : { name }) }
          savedImages.push(ref)
          return ref
        },
      }
    return undefined
  },
}
const savedImages = []

const { apply } = await import('./view-image.js')
apply(ctx, {})

const tool = captured.find((t) => t.name === 'view_image')
assert.ok(tool, 'view_image registered')

const makeExec = () => ({
  agent: { session: { header: { cwd: 'C:/tmp' }, append() {} }, ctx: { effect: () => () => {} } },
  signal: new AbortController().signal,
  callId: 'call-1',
})
const run = (args, exec = makeExec()) => tool.execute(args, exec)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const TEXT = new TextEncoder().encode('not an image')

// ── PNG happy path (explicit + default detail) ─────────────────────────────
blobs.set('C:/tmp/pic.png', PNG)
const value = await run({ path: 'pic.png', detail: 'high' })
assert.ok(value.image_url.startsWith('data:application/octet-stream;base64,'), 'octet-stream data URL')
assert.equal(value.detail, 'high', 'detail echoed')
assert.equal(value.mime, 'image/png', 'mime detected')
assert.equal(value.bytes, PNG.byteLength, 'byte count')
assert.equal(value.image_url, `data:application/octet-stream;base64,${Buffer.from(PNG).toString('base64')}`, 'canonical base64 payload')

const defaulted = await run({ path: 'pic.png' })
assert.equal(defaulted.detail, 'high', 'detail defaults to high')

// ── WebP magic number ──────────────────────────────────────────────────────
blobs.set('C:/tmp/pic.webp', WEBP)
const webp = await run({ path: 'pic.webp' })
assert.ok(webp.image_url.startsWith('data:application/octet-stream;base64,'), 'webp also octet-stream data URL')

// ── extension is irrelevant: a .txt file carrying PNG bytes still decodes ──
blobs.set('C:/tmp/actually-png.txt', PNG)
const disguised = await run({ path: 'actually-png.txt' })
assert.equal(disguised.mime, 'image/png', 'extension gating removed (magic number drives detection)')

// ── render: attachment path emits [text, image block]; no URL in text ──────
assert.ok(value.image !== undefined, 'canonical value carries the attachment ref')
assert.equal(value.image.attachmentId, 'att-1', 'attachment saved once')
const smallBlocks = tool.output.render({ path: 'pic.png' }, value)
assert.equal(smallBlocks.length, 2, 'render emits text + image block')
assert.equal(smallBlocks[0].type, 'text')
assert.ok(smallBlocks[0].text.startsWith('Image loaded: image/png'), 'render text header')
assert.equal(smallBlocks[1].type, 'image', 'render emits an image block')
assert.equal(smallBlocks[1].attachment.attachmentId, 'att-1', 'image block carries the attachment ref')

const large = new Uint8Array(20 * 1024) // 20KB > 16KB inline threshold, < 200KB attachment limit
large.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
blobs.set('C:/tmp/big.png', large)
const bigValue = await run({ path: 'big.png', detail: 'original' })
const bigBlocks = tool.output.render({ path: 'big.png' }, bigValue)
assert.equal(bigBlocks.length, 2, 'large image also emits image block')
assert.ok(bigBlocks[0].text.startsWith('Image loaded: image/png 20480 bytes (original)'), 'large render header')
assert.ok(!bigBlocks[0].text.includes('data:application/octet-stream'), 'data URL never in render text (attachment path)')
assert.ok(bigValue.image_url.startsWith('data:application/octet-stream;base64,'), 'canonical value still carries full URL')

// ── invalid image data (no extension gating, no magic-number match) ────────
blobs.set('C:/tmp/readme.txt', TEXT)
await assert.rejects(
  () => run({ path: 'readme.txt' }),
  /unable to process image: invalid or unsupported image data/,
  'invalid image data rejected'
)

// ── >200KB decodes (no hard cap); over the attachment limit it skips save ──
const huge = new Uint8Array(200 * 1024 + 1)
huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
blobs.set('C:/tmp/huge.png', huge)
const hugeValue = await run({ path: 'huge.png' })
assert.ok(hugeValue.image_url.startsWith('data:application/octet-stream;base64,'), 'oversized image decodes (no hard cap error)')
assert.equal(hugeValue.image, undefined, 'over-attachment-limit image skips the attachment save')

// ── official error strings ─────────────────────────────────────────────────
await assert.rejects(() => run({ path: 'nope.png' }), /unable to locate image at `nope\.png`: file not found/, 'missing file error')
await assert.rejects(() => run({ path: 'dir/file.png' }), /image path `dir\/file\.png` is not a file/, 'not-a-regular-file error')
await assert.rejects(() => run({ path: 'locked.png' }), /unable to read image at `locked\.png`: cannot read/, 'read failure error')
await assert.rejects(() => run({ path: 'bad/x.png' }), /unable to resolve image path `bad\/x\.png` against environment cwd `C:\/tmp`: EACCES/, 'resolution failure error')

// ── missing agent ──────────────────────────────────────────────────────────
await assert.rejects(
  () => tool.execute({ path: 'pic.png' }, { signal: new AbortController().signal }),
  /view_image requires an owning agent session/,
  'agent required'
)

// ── schema spot checks ─────────────────────────────────────────────────────
assert.ok(tool.parameters.required.includes('path'), 'path required')
assert.deepEqual(tool.parameters.properties.detail.enum, ['high', 'original'], 'detail enum')
assert.ok(!tool.parameters.required.includes('detail'), 'detail optional')
assert.deepEqual(tool.output.schema.required, ['image_url'], 'output requires only image_url')
assert.ok(tool.output.schema.properties.mime !== undefined && !(tool.output.schema.required ?? []).includes('mime'), 'mime optional')
assert.ok(tool.output.schema.properties.bytes !== undefined && !(tool.output.schema.required ?? []).includes('bytes'), 'bytes optional')

console.log('view-image smoke test: ALL PASS')
