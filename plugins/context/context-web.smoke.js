import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, latestReportedBudget } from './context-web.js'
import { initializeContextState, writeActiveNote } from './context-state.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-web-'))
process.env.DSH_CODEX_CONTEXT_DIR = root
try {
  const session = { id: 'web-context-test', header: { agentPreset: 'codex' }, seq: 0,
    snapshotEvents: () => [], requestContext: () => ({ provider: 'test', model: 'test', contextWindow: 8192 }),
    requestHeader: () => undefined }
  initializeContextState(session, 'startup')
  writeActiveNote(session, 'private handoff')
  let route
  let coldDisposed = false
  apply({ sessionProjections: { register() {} }, connection: { fetch: { register: definition => { route = definition } } },
    sessions: { get: id => id === session.id ? session : undefined },
    sessionQuery: { observeSession: async id => {
      if (id !== 'cold-context-test') throw new Error('not found')
      return { header: { agentPreset: 'codex' }, events: [], [Symbol.dispose]() { coldDisposed = true } }
    } },
    tokenMeter: { measure: () => ({ totalTokens: 1200 }) }, llm: {}, logger: { warn: () => {} } })
  assert.equal(route.path, '/api/codex-context.state')
  assert.deepEqual(route.methods, ['GET', 'HEAD'])
  const head = await route.fetch(new Request(`http://localhost${route.path}?sessionId=${session.id}`, { method: 'HEAD' }))
  assert.equal(head.status, 204)
  assert.equal(head.body, null)
  const response = await route.fetch(new Request(`http://localhost${route.path}?sessionId=${session.id}`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.note.content, 'private handoff')
  assert.equal(body.budget.estimatedRemaining, 8192 - 1200)
  const result = (seq, callId, remaining, isError = false) => ({ seq, time: 1233 + seq, type: 'tool/result',
    data: { message: { source: { callId }, content: [{ type: 'tool-result', isError,
      content: [{ type: 'text', text: JSON.stringify({ estimatedRemaining: remaining, capacity: 8192 }) }] }] } } })
  const events = [
    { seq: 0, type: 'tool/call', data: { name: 'get_context_remaining', callId: 'our-call' } },
    result(1, 'our-call', 500),
    { seq: 2, type: 'tool/call', data: { name: 'get_context_remaining', callId: 'failed' } },
    result(3, 'failed', 9, true),
  ]
  assert.deepEqual(latestReportedBudget({ snapshotEvents: (from = 0) => events.slice(from) }, 0),
    { modelRemaining: 500, toolCapacity: 8192, modelUpdatedAt: 1234 })
  assert.deepEqual(latestReportedBudget({ snapshotEvents: (from = 0) => events.slice(from) }, 2), {})
  initializeContextState({ ...session, id: 'cold-context-test' }, 'startup')
  const cold = await route.fetch(new Request(`http://localhost${route.path}?sessionId=cold-context-test`))
  assert.equal((await cold.json()).enabled, true)
  assert.equal(coldDisposed, true)
  const invalid = await route.fetch(new Request(`http://localhost${route.path}?sessionId=../secret`))
  assert.equal(invalid.status, 400)
  assert.equal((await route.fetch(new Request(`http://localhost${route.path}?sessionId=someone-else`))).status, 500)
  console.log('context authenticated route smoke: ALL PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.DSH_CODEX_CONTEXT_DIR
}
