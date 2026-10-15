import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initializeContextState, readContextState, readActiveNote, writeActiveNote, reconcileContextState, requestContextWindow } from './context-state.js'
import { notePage, windowsPage } from './context-tools.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-state-'))
const previous = process.env.DSH_CODEX_CONTEXT_DIR
process.env.DSH_CODEX_CONTEXT_DIR = root
function fixture(id, events = [], parentSession) {
  return { id, header: { parentSession, isSeeded: Boolean(parentSession) }, inheritedEventCount: events.length,
    get seq() { return events.length }, snapshotEvents: (from = 0, end = events.length) => events.slice(from, end), eventAt: seq => events[seq], events }
}
function checkpoint(session, id, kind = 'note-reset') {
  session.events.push({ seq: session.seq, type: 'compaction/summary', data: { compactionId: id,
    summary: [{ type: 'text', text: `[codex-context-${kind}:v1]\ncheckpoint` }] } })
  session.events.push({ seq: session.seq, type: 'user/message', surfaceOp: { op: 'replace' }, data: { source: { compactionId: id } } })
}
try {
  const s = fixture('state')
  initializeContextState(s, 'startup')
  const args = { operationId: 'write-1', coverage: { beforeSeq: 1 } }
  const first = writeActiveNote(s, 'a'.repeat(20000), false, args)
  assert.equal(first.persisted, true)
  assert.deepEqual(writeActiveNote(s, 'a'.repeat(20000), false, args), first)
  assert.throws(() => writeActiveNote(s, 'different', false, args), /conflict/)
  assert.throws(() => writeActiveNote(s, 'new', false, { expectedRevision: 0 }), /conflict/)
  const page = notePage(s)
  assert.equal(page.text.length, 8192)
  assert.equal(readContextState(s).noteRead, false)
  const second = notePage(s, { cursor: page.nextCursor })
  notePage(s, { cursor: second.nextCursor })
  assert.equal(readContextState(s).noteRead, true)
  assert.equal(requestContextWindow(s, 1, 'reset').status, 'requested')
  checkpoint(s, 'crash') // Replacement is authoritative even without an end or manifest update.
  const recovered = reconcileContextState(s)
  assert.equal(recovered.windowId, 'window-crash')
  assert.equal(recovered.freshNoteRevision, 0)
  assert.equal(recovered.noteRead, false)
  assert.equal(recovered.pending, null)
  assert.equal(reconcileContextState(s).windows.length, 2)
  assert.throws(() => requestContextWindow(s, 1), /fresh Note/)
  const child = fixture('fork', s.events.slice(), s.id)
  initializeContextState(child, 'startup')
  assert.equal(readActiveNote(child), 'a'.repeat(20000))
  assert.equal(readContextState(child).freshNoteRevision, 0)
  writeActiveNote(s, 'later parent')
  assert.equal(readActiveNote(child), 'a'.repeat(20000))
  assert.throws(() => notePage(s, { cursor: page.nextCursor }), /Note changed/)
  assert.throws(() => notePage(child, { cursor: page.nextCursor }), /Invalid cursor/)
  checkpoint(s, 'fallback', 'summary-fallback')
  reconcileContextState(s)
  assert.equal(readActiveNote(s), null)
  assert.equal(readContextState(s).revisions.length, 2)
  assert.equal(windowsPage(s, { limit: 1 }).nextOffset, 1)
  assert.equal(initializeContextState(fixture('legacy'), 'resume').mode, 'native')
  console.log('Notes state: atomic revision/idempotence, paging, fork isolation, crash recovery, fallback PASS')
} finally {
  if (previous === undefined) delete process.env.DSH_CODEX_CONTEXT_DIR
  else process.env.DSH_CODEX_CONTEXT_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
}
