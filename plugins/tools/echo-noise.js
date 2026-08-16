/**
 * Model echo-noise normalization shared by the codex tool surface.
 *
 * Models on the OpenAI wire (observed: gpt-5.6-via-cc-switch) routinely echo a
 * tool's FULL optional schema on every call — optional string fields come back
 * as `""`/whitespace, optional arrays come back as stub entries with every
 * field empty. Codex's own CLI models do not do this, so the verbatim codex
 * argument validation hard-fails such calls. The dsh-codex adaptation: keep
 * the codex wire/schema/error-text alignment for genuinely malformed inputs
 * (alignment smoke tests guard that), but normalize echo noise BEFORE the
 * codex validation — the same rule applied to exec_command's justification
 * blank exemption and multi_agent's message-vs-items union.
 *
 * Rules:
 * - a blank/whitespace string is "absent" (omit the key);
 * - an array whose entries are ALL empty stubs is "absent" (treated as if the
 *   model sent nothing), while a deliberate `[]` stays `[]` so the caller's
 *   own "cannot be empty" error still fires;
 * - empty stub ENTRIES are stripped from arrays that keep at least one
 *   meaningful entry.
 *
 * @module dsh-codex/tools/echo-noise
 */

/** True when the value is a string with no non-whitespace content. */
export function isBlankText(value) {
  return typeof value === 'string' && value.trim().length === 0
}

/**
 * Drop a key whose value is blank/whitespace, cloning only when needed.
 * Used for optional string fields the model echoes as `""`.
 */
export function omitBlank(obj, key) {
  if (!isBlankText(obj[key])) return obj
  const { [key]: _dropped, ...rest } = obj
  return rest
}

/**
 * True when the entry has at least one meaningful (non-blank string) field.
 * An all-empty object — models echo placeholders like
 * `{audio_url:"", image_url:"", name:"", path:"", text:"", type:""}` — is a
 * stub and must not drive behavior; absent fields count as empty, never as
 * meaningful (only a present, non-blank string value earns the entry).
 */
export function meaningfulEntry(entry, fields) {
  if (entry === null || typeof entry !== 'object') return false
  return fields.some((field) => {
    const value = entry[field]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/**
 * Strip stub entries and collapse an all-stub array to "absent".
 * @param items - the raw `items` argument.
 * @param fields - the content-bearing field names to judge entries by.
 * @returns the same array reference when nothing was removed, the filtered
 *   array when some stubs were dropped, `undefined` when the model sent a
 *   non-empty array with no meaningful entry (echo noise), and `[]` when the
 *   model deliberately sent an empty array.
 */
export function stripStubEntries(items, fields) {
  if (!Array.isArray(items)) return items
  const kept = items.filter((entry) => meaningfulEntry(entry, fields))
  if (items.length > 0 && kept.length === 0) return undefined
  return kept
}