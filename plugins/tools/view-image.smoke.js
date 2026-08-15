/**
 * M1 smoke test for dsh-codex/tools/view-image.js — in-memory mock `ctx.fs`
 * serving raw bytes, exercising magic-number detection, the 200KB cap, and the
 * render-text data URL policy (inline ≤ 16KB, truncated prefix otherwise).
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
    const abs = normJoin(opts.cwd ?? 'C:/tmp', path)
    return { targetKey: abs, displayPath: abs }
  },
  async readBytes(target, signal, maxBytes) {
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
assert.ok(value.image_url.startsWith('data:image/png;base64,'), 'png data URL')
assert.equal(value.detail, 'high', 'detail echoed')
assert.equal(value.mime, 'image/png', 'mime detected')
assert.equal(value.bytes, PNG.byteLength, 'byte count')
assert.equal(value.image_url, `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, 'canonical base64 payload')

const defaulted = await run({ path: 'pic.png' })
assert.equal(defaulted.detail, 'high', 'detail defaults to high')

// ── WebP magic number ──────────────────────────────────────────────────────
blobs.set('C:/tmp/pic.webp', WEBP)
const webp = await run({ path: 'pic.webp' })
assert.ok(webp.image_url.startsWith('data:image/webp;base64,'), 'webp data URL')

// ── render: attachment path emits [text, image block]; no URL in text ──────
assert.ok(value.image !== undefined, 'canonical value carries the attachment ref')
assert.equal(value.image.attachmentId, 'att-1', 'attachment saved once')
const smallBlocks = tool.output.render({ path: 'pic.png' }, value)
assert.equal(smallBlocks.length, 2, 'render emits text + image block')
assert.equal(smallBlocks[0].type, 'text')
assert.ok(smallBlocks[0].text.startsWith('Image loaded: image/png'), 'render text header')
assert.equal(smallBlocks[1].type, 'image', 'render emits an image block')
assert.equal(smallBlocks[1].attachment.attachmentId, 'att-1', 'image block carries the attachment ref')

const large = new Uint8Array(20 * 1024) // 20KB > 16KB inline threshold, < 200KB cap
large.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
blobs.set('C:/tmp/big.png', large)
const bigValue = await run({ path: 'big.png', detail: 'original' })
const bigBlocks = tool.output.render({ path: 'big.png' }, bigValue)
assert.equal(bigBlocks.length, 2, 'large image also emits image block')
assert.ok(bigBlocks[0].text.startsWith('Image loaded: image/png 20480 bytes (original)'), 'large render header')
assert.ok(!bigBlocks[0].text.includes('data:image/png'), 'data URL never in render text (attachment path)')
assert.ok(bigValue.image_url.startsWith('data:image/png;base64,'), 'canonical value still carries full URL')

// ── non-image rejected ─────────────────────────────────────────────────────
blobs.set('C:/tmp/readme.txt', TEXT)
await assert.rejects(
  () => run({ path: 'readme.txt' }),
  /only accepts PNG\/JPEG\/GIF\/WebP files/,
  'non-image extension rejected'
)

// ── >200KB rejected ────────────────────────────────────────────────────────
const huge = new Uint8Array(200 * 1024 + 1)
huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
blobs.set('C:/tmp/huge.png', huge)
await assert.rejects(
  () => run({ path: 'huge.png' }),
  /image exceeds the \d+ byte limit/,
  'oversized image rejected'
)

// ── missing file and missing agent ─────────────────────────────────────────
await assert.rejects(() => run({ path: 'nope.png' }), /file not found/, 'missing file errors')
await assert.rejects(
  () => tool.execute({ path: 'pic.png' }, { signal: new AbortController().signal }),
  /view_image requires an owning agent session/,
  'agent required'
)

// ── schema spot checks ─────────────────────────────────────────────────────
assert.ok(tool.parameters.required.includes('path'), 'path required')
assert.deepEqual(tool.parameters.properties.detail.enum, ['high', 'original'], 'detail enum')
assert.ok(!tool.parameters.required.includes('detail'), 'detail optional')

console.log('view-image smoke test: ALL PASS')
