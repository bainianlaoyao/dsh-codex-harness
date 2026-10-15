import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { initializeContextState, writeActiveNote } from '../context/context-state.js'
import { CodexContextCompactionEngine } from './codex-context-compaction.js'
assert.equal(Object.getPrototypeOf(CodexContextCompactionEngine.prototype), BasicCompactionEngine.prototype)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-route-'))
const previous = process.env.DSH_CODEX_CONTEXT_DIR
process.env.DSH_CODEX_CONTEXT_DIR = root
try {
  const session = { id: 'route', header: {}, seq: 0, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'recorded' } }) }
  initializeContextState(session, 'startup')
  const engine = Object.create(CodexContextCompactionEngine.prototype)
  let native = 0, reset = 0
  engine.nativeManualCompact = async () => { native++; return null }
  engine.manualCompact = async () => { reset++; return null }
  const agent = { session, options: { provider: 'p', model: 'changed-next-model' } }
  await engine.compactNow(agent, new AbortController().signal)
  assert.equal(native, 1)
  writeActiveNote(session, 'covered handoff', false, { coverage: { beforeSeq: 1 } })
  await engine.compactNow(agent, new AbortController().signal)
  assert.equal(reset, 1, 'latest recorded route is sufficient; no private route-freeze field')
  console.log('Notes compaction native ownership and route semantics PASS')
} finally {
  if (previous === undefined) delete process.env.DSH_CODEX_CONTEXT_DIR
  else process.env.DSH_CODEX_CONTEXT_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
}
