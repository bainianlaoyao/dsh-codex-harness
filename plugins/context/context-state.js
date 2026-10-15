/** Private Notes state; DSH owns the conversation log and surface. Note bytes
 * are immutable. One atomic manifest commits revision/history references. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

const ROOT = () => process.env.DSH_CODEX_CONTEXT_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'codex-context')
const MAX_NOTE_BYTES = 1_000_000
const native = Object.freeze({ mode: 'native' })
const location = session => {
  const id = String(session?.id || '')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session identity for Codex context store')
  return path.join(ROOT(), id)
}
const digestOf = text => createHash('sha256').update(text).digest('hex')
const metaFile = session => path.join(location(session), 'state.json')
const blobFile = (session, digest) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid Note digest')
  return path.join(location(session), 'notes', digest + '.md')
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    const handle = fs.openSync(temp, 'wx', 0o600)
    try { fs.writeFileSync(handle, content); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    fs.renameSync(temp, file)
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r')
      try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    }
  } finally { try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
const save = (session, state) => atomicWrite(metaFile(session), JSON.stringify(state))

export function readContextState(session) {
  let state
  try { state = JSON.parse(fs.readFileSync(metaFile(session), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return native; throw error }
  if (state?.mode !== 'notes' || !Array.isArray(state.windows) || !state.windowId || !Number.isSafeInteger(state.noteRevision)) {
    throw new Error('Invalid persisted Codex context state; refusing reset')
  }
  if (state.version !== undefined && state.version !== 2) throw new Error('Unsupported Notes state version')
  return state
}
function readRevision(session, revision) {
  const value = fs.readFileSync(blobFile(session, revision.digest), 'utf8')
  if (digestOf(value) !== revision.digest) throw new Error('Note digest mismatch; refusing reset')
  return value
}

export function initializeContextState(session, source) {
  let previous = readContextState(session)
  if (previous.mode === 'notes') {
    // Migrate the prototype without inventing model coverage for its old Note.
    if (previous.version !== 2) {
      const note = previous.noteRevision ? fs.readFileSync(path.join(location(session), 'note.md'), 'utf8') : null
      const digest = note === null ? null : digestOf(note)
      if (note !== null) atomicWrite(blobFile(session, digest), note)
      previous = { ...previous, version: 2, noteDigest: digest, freshNoteRevision: 0, coverage: null,
        nextRevision: previous.noteRevision, revisions: note === null ? [] : [{ revision: previous.noteRevision,
          digest, atSeq: previous.lastSeq ?? session.seq, windowId: previous.noteOwnerWindowId, coverage: null }], pending: null }
      save(session, previous)
    }
    const current = reconcileContextState(session)
    const latest = current.revisions.find(row => row.revision === current.noteRevision)
    if (source === 'resume' && latest?.operationId && !session.snapshotEvents().some(event =>
      event.type === 'tool/result' && event.data.message?.source?.callId === latest.operationId &&
      !event.data.message.isError && !event.data.message.content?.[0]?.isError)) {
      save(session, { ...current, freshNoteRevision: 0, coverage: null, pending: null })
      return readContextState(session)
    }
    return current
  }
  if (source !== 'startup') return previous
  if (session.header.parentSession && session.header.isSeeded) {
    const parent = { id: session.header.parentSession }
    const inherited = readContextState(parent)
    if (inherited.mode !== 'notes') return native
    if (inherited.version !== 2) throw new Error('Resume the parent once to migrate its Notes before forking')
    const cut = session.inheritedEventCount
    if (!Number.isSafeInteger(cut)) throw new Error('Fork requires the exact inherited event count')
    const windows = inherited.windows.filter(window => (window.commitSeq ?? window.seq) < cut || window.kind === 'initial')
    const latestWindow = windows.at(-1)
    const revisions = inherited.revisions.filter(row => row.atSeq < cut)
    const fallback = [...windows].reverse().find(window => window.kind === 'summary-fallback')
    const active = revisions.filter(row => !fallback || row.atSeq > fallback.commitSeq).at(-1)
    for (const revision of revisions) atomicWrite(blobFile(session, revision.digest), readRevision(parent, revision))
    const forked = { ...inherited, windows, windowId: latestWindow.id, revisions,
      nextRevision: revisions.at(-1)?.revision ?? 0, noteRevision: active?.revision ?? 0,
      noteDigest: active?.digest ?? null, noteOwnerWindowId: active?.windowId ?? null,
      coverage: null, freshNoteRevision: 0, noteRead: false, readRanges: [], pending: null, lastSeq: session.seq }
    save(session, forked)
    return reconcileContextState(session)
  }
  if (session.snapshotEvents().some(event => event.type === 'turn/start')) return native
  const windowId = randomUUID()
  const state = { version: 2, mode: 'notes', windowId, noteRevision: 0, nextRevision: 0,
    noteDigest: null, freshNoteRevision: 0, noteOwnerWindowId: null, coverage: null,
    noteRead: false, readRanges: [], revisions: [], pending: null,
    windows: [{ id: windowId, kind: 'initial', seq: session.seq, time: Date.now() }], lastSeq: session.seq }
  save(session, state)
  return state
}

export function readActiveNote(session) {
  const state = readContextState(session)
  if (state.mode !== 'notes' || state.noteRevision === 0) return null
  if (state.version !== 2) return fs.readFileSync(path.join(location(session), 'note.md'), 'utf8')
  return readRevision(session, { digest: state.noteDigest })
}

/** Capture only the surface that preceded the assistant which requested this
 * tool (including PTC root calls). Never include sibling results or steering. */
export function noteCoverage(session, callId) {
  if (!callId) return null
  const assistant = session.snapshotEvents().findLast(event => event.type === 'assistant/message' &&
    event.data.message.content.some(block => block.type === 'tool-call' && String(block.id) === String(callId)))
  return assistant ? { beforeSeq: assistant.seq } : null
}

export function writeActiveNote(session, text, append = false, { expectedRevision, operationId, coverage } = {}) {
  const state = readContextState(session)
  if (state.mode !== 'notes' || state.version !== 2) throw new Error('Codex Notes are unavailable in this legacy session')
  if (typeof text !== 'string') throw new TypeError('Note text must be a string')
  const operationDigest = digestOf(JSON.stringify({ text, append, expectedRevision }))
  const prior = operationId && state.revisions.find(row => row.operationId === operationId)
  if (prior) {
    if (prior.operationDigest !== operationDigest) throw new Error('Note operation ID conflict')
    return { revision: prior.revision, windowId: prior.windowId, bytes: prior.bytes, persisted: true }
  }
  if (expectedRevision !== undefined && expectedRevision !== state.noteRevision) throw new Error('Note revision conflict; read the current Note before retrying')
  const next = (append ? readActiveNote(session) ?? '' : '') + text
  if (!next.trim()) throw new Error('Note must not be empty')
  const bytes = Buffer.byteLength(next, 'utf8')
  if (bytes > MAX_NOTE_BYTES) throw new Error('Note exceeds 1,000,000 UTF-8 bytes')
  const digest = digestOf(next)
  atomicWrite(blobFile(session, digest), next)
  const revision = (state.nextRevision ?? state.noteRevision) + 1
  const record = { revision, digest, bytes, windowId: state.windowId, atSeq: session.seq,
    coverage: coverage ?? null, ...(operationId ? { operationId, operationDigest } : {}) }
  save(session, { ...state, noteRevision: revision, nextRevision: revision, noteDigest: digest,
    freshNoteRevision: revision, noteOwnerWindowId: state.windowId, noteRead: false, readRanges: [],
    coverage: record.coverage, revisions: [...state.revisions, record], pending: null, lastSeq: session.seq })
  return { revision, windowId: state.windowId, bytes, persisted: true }
}

export function markNoteRead(session, start = 0, end = Infinity, revision) {
  const state = readContextState(session)
  if (state.mode !== 'notes' || (revision !== undefined && revision !== state.noteRevision)) return
  const note = readActiveNote(session)
  if (note === null) return
  const ranges = [...(state.readRanges ?? []), [start, Math.min(end, note.length)]].sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  save(session, { ...state, readRanges: merged, noteRead: merged[0]?.[0] === 0 && merged[0]?.[1] >= note.length })
}

export function requestContextWindow(session, noteRevision, operationId) {
  const state = readContextState(session)
  if (state.mode !== 'notes' || state.noteRevision !== noteRevision || state.freshNoteRevision !== noteRevision || !state.coverage) {
    throw new Error('Write a fresh Note in this window before requesting new_context')
  }
  if (state.pending) return { status: 'requested', requestId: state.pending.id }
  const pending = { id: operationId || randomUUID(), noteRevision, windowId: state.windowId }
  save(session, { ...state, pending })
  return { status: 'requested', requestId: pending.id }
}
export function declineContextRequest(session, reason) {
  const state = readContextState(session)
  save(session, { ...state, pending: null, lastDeclined: reason })
}

/** The landed DSH replacement, not a secondary JSON write, determines whether
 * rollover happened. Reconcile even when compaction/end records a close error. */
export function reconcileContextState(session) {
  let state = readContextState(session)
  if (state.mode !== 'notes' || state.version !== 2) return state
  const events = session.snapshotEvents()
  let changed = false
  for (const event of events) {
    if (event.type !== 'compaction/summary' || state.windows.some(w => w.dividerId === event.data.compactionId)) continue
    const head = event.data.summary?.find(block => block.type === 'text')?.text ?? ''
    const kind = head.startsWith('[codex-context-note-reset:v1]') ? 'note-reset'
      : head.startsWith('[codex-context-summary-fallback:v1]') ? 'summary-fallback' : null
    if (!kind) continue
    const replacement = events.find(row => row.type === 'user/message' && row.surfaceOp?.op === 'replace' &&
      row.data.source?.compactionId === event.data.compactionId)
    if (!replacement) continue
    const id = `window-${event.data.compactionId}`
    state = { ...state, windowId: id, freshNoteRevision: 0, noteRead: false, readRanges: [], pending: null,
      lastSeq: replacement.seq + 1, windows: [...state.windows, { id, kind, seq: replacement.seq,
        commitSeq: replacement.seq, dividerSeq: event.seq, dividerId: event.data.compactionId, time: event.time }] }
    if (kind === 'summary-fallback') state = { ...state, noteRevision: 0, noteDigest: null, noteOwnerWindowId: null, coverage: null }
    changed = true
  }
  if (changed) save(session, state)
  return state
}
export function commitContextWindow(session, { expectedWindowId, expectedNoteRevision, checkpointSeq }) {
  const state = readContextState(session)
  if (state.windowId !== expectedWindowId || state.noteRevision !== expectedNoteRevision || !state.freshNoteRevision || !session.eventAt(checkpointSeq)) throw new Error('Note/window checkpoint changed; refusing reset')
  return reconcileContextState(session)
}
export function clearActiveNote(session) { return reconcileContextState(session) }
