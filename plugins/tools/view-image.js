/**
 * dsh-codex M1 — `view_image` local-image reader.
 *
 * Codex-parity schema (HEAD 5bc8da6d78, view_image_spec.rs) with the reading
 * backend mapped onto `ctx.fs`: the file is read as raw bytes, validated by
 * magic number, and returned as a `data:<mime>;base64,<b64>` URL.
 *
 * M1 transition implementation: the canonical value carries the FULL data URL,
 * but the model-facing render text never embeds large URLs (images ≤ 16KB are
 * inlined; anything larger is truncated to a prefix) — image-block attachment
 * is deferred to M2.
 *
 * @module dsh-codex/tools/view-image
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-codex-view-image'
export const inject = ['tools', 'fs']

/** 200KB cap on the image payload; M2 adds a visual online channel for larger images. */
const MAX_IMAGE_BYTES = 200 * 1024
/** 16KB threshold below which the render text inlines the full data URL. */
const INLINE_TEXT_BYTES = 16 * 1024
/** Prefix length of the data URL kept in render text for larger images. */
const TRUNCATED_PREFIX_CHARS = 256

/**
 * Detect the MIME type of raw image bytes by magic number; `null` when the
 * payload is not a supported PNG/JPEG/GIF/WebP image.
 * @param {Uint8Array} bytes - raw file bytes.
 * @returns {string|null} MIME type or null.
 */
function detectImageMime(bytes) {
  const len = bytes.length
  if (
    len >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (len >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (
    len >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function renderViewImage(_args, value) {
  const body = `Image loaded: ${value.mime} ${value.bytes} bytes (${value.detail})`
  if (value.image !== undefined) {
    // Real image block: the wire adapter carries the raster to the model.
    return [
      { type: 'text', text: body },
      { type: 'image', attachment: value.image },
    ]
  }
  // Fallback without an attachment service: bounded text data URL (legacy M1 path).
  if (value.bytes <= INLINE_TEXT_BYTES) return [{ type: 'text', text: `${body}\n${value.image_url}` }]
  return [{ type: 'text', text: `${body}\n${value.image_url.slice(0, TRUNCATED_PREFIX_CHARS)}…(truncated in text; full URL in canonical output)` }]
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'view_image',
      description:
        'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
      parameters: {
        path: { type: 'string', required: true, description: 'Local filesystem path to an image file.' },
        detail: {
          type: 'string',
          enum: ['high', 'original'],
          description: 'Image detail level. Defaults to `high`; use `original` to preserve exact resolution.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            image_url: { type: 'string', required: true, description: 'Data URL for the loaded image.' },
            detail: {
              type: 'string',
              required: true,
              enum: ['high', 'original'],
              description: 'Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved.',
            },
            mime: { type: 'string', required: true, description: 'Detected image MIME type.' },
            bytes: { type: 'integer', required: true, description: 'Size of the image payload in bytes.' },
            image: {
              type: 'object',
              additionalProperties: false,
              description: 'Durable attachment reference carried in the model-facing image block.',
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
        },
        render: renderViewImage,
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error('view_image requires an owning agent session')
        const cwd = agent.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw new Error('view_image: no working directory on the owning agent session')
        }
        const detail = args.detail ?? 'high'
        const target = await ctx.fs.resolve(args.path, { cwd })
        const mediaType = imageMediaTypeForPath(target.displayPath)
        if (mediaType === undefined) throw new Error('view_image only accepts PNG/JPEG/GIF/WebP files')
        const attachments = ctx.get('attachments')
        const byteCap = Math.min(MAX_IMAGE_BYTES, attachments?.imageLimits?.maxImageBytes ?? MAX_IMAGE_BYTES)
        let bytes
        try {
          bytes = await ctx.fs.readBytes(target, exec.signal, byteCap)
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'FS_TOO_LARGE') {
            throw new Error(`view_image: image exceeds the ${byteCap} byte limit`)
          }
          throw error
        }
        if (bytes.byteLength > byteCap) {
          throw new Error(`view_image: image exceeds the ${byteCap} byte limit (${bytes.byteLength} bytes)`)
        }
        const mime = detectImageMime(bytes)
        if (mime === null) {
          throw new Error('view_image: file is not a supported image (PNG/JPEG/GIF/WebP)')
        }
        const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
        const imageUrl = `data:${mime};base64,${base64}`
        let image
        if (attachments !== undefined) {
          const ref = await attachments.saveImage({ data: bytes, mediaType: mime, name: basename(target.displayPath) })
          image = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          }
        }
        return { image_url: imageUrl, detail, mime, bytes: bytes.byteLength, ...(image === undefined ? {} : { image }) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'View image', kind: 'other', rawInput: args.path }),
    })
  )
}

function imageMediaTypeForPath(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return undefined
}

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}
