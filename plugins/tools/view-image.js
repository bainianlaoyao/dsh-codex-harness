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

/** Generous read bound for the fs seam. Codex decodes the whole image with no
 *  size cap; the DSH seam requires a finite `maxBytes`, so this only bounds
 *  pathological inputs rather than rejecting ordinary large images. */
const MAX_IMAGE_READ_BYTES = 100 * 1024 * 1024
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

/** Best-effort human-readable rendering of a thrown seam error. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
              enum: ['high', 'original'],
              description: 'Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved.',
            },
            mime: { type: 'string', description: 'Detected image MIME type (internal, for the attachment path).' },
            bytes: { type: 'integer', description: 'Size of the image payload in bytes (internal).' },
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
        let target
        try {
          target = await ctx.fs.resolve(args.path, { cwd })
        } catch (error) {
          throw new Error(
            `unable to resolve image path \`${args.path}\` against environment cwd \`${cwd}\`: ${errorMessage(error)}`
          )
        }
        const attachments = ctx.get('attachments')
        let bytes
        try {
          bytes = await ctx.fs.readBytes(target, exec.signal, MAX_IMAGE_READ_BYTES)
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? error.code : undefined
          if (code === 'FS_NOT_FOUND') {
            throw new Error(`unable to locate image at \`${args.path}\`: ${errorMessage(error)}`)
          }
          if (code === 'FS_NOT_REGULAR_FILE') {
            throw new Error(`image path \`${args.path}\` is not a file`)
          }
          throw new Error(`unable to read image at \`${args.path}\`: ${errorMessage(error)}`)
        }
        const mime = detectImageMime(bytes)
        if (mime === null) {
          throw new Error('unable to process image: invalid or unsupported image data')
        }
        const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
        const imageUrl = `data:application/octet-stream;base64,${base64}`
        let image
        if (attachments !== undefined) {
          const maxImageBytes = attachments.imageLimits?.maxImageBytes
          if (maxImageBytes === undefined || bytes.byteLength <= maxImageBytes) {
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
        }
        return { image_url: imageUrl, detail, mime, bytes: bytes.byteLength, ...(image === undefined ? {} : { image }) }
      },
      presentCall: (args) => ({ card: 'generic', title: 'View image', kind: 'other', rawInput: args.path }),
    })
  )
}

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}
