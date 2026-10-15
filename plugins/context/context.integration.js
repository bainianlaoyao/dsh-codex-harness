import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Compaction from '../harness/codex-context-compaction.js'
import * as mode from './context-mode.js'
import * as tools from './context-tools.js'
import { readContextState, readActiveNote } from './context-state.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notes-integration-'))
const previous = process.env.DSH_CODEX_CONTEXT_DIR
process.env.DSH_CODEX_CONTEXT_DIR = path.join(root, 'notes')
const ctx = new Context()
let handle, compactor
const requests = []
const text = value => [{ type: 'text', text: value }]
function* call(name, args, id) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class Model extends LlmAdapter {
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
  async *stream(request) {
    requests.push(structuredClone({ messages: request.messages, tools: request.tools }))
    switch (requests.length) {
      case 1: yield* call('write_context_note', { text: 'Original task: continue the fixture. Preserve user corrections. Next: inspect history.' }, 'note-1'); return
      case 2: {
        const result = request.messages.findLast(m => m.role === 'tool') ?? request.messages.flatMap(m => m.content).findLast(b => b.type === 'tool-result')
        const revision = JSON.parse(result.content[0].text).revision
        // Steering after the Note was authored must survive the reset.
        handle.agent.steer(createUserMessage({ content: text('NEW CORRECTION: keep the blue file'), source: { kind: 'user' } }))
        yield* call('new_context', { noteRevision: revision }, 'reset-1'); return
      }
      case 3: yield* call('read_context_note', {}, 'read-1'); return
      default:
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continued' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
try {
  new Sessions(ctx)
  new Projections(ctx)
  new Persistence(ctx, { root: path.join(root, 'sessions'), compression: 'none' })
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, resolveConfig(SystemPrompt, {}))
  new Tools(ctx)
  new Llm(ctx)
  new TokenMeter(ctx)
  ctx.llm.registerAdapter(['fixture'], new Model())
  new AgentLoop(ctx, resolveConfig(AgentLoop, { agents: [], maxParallelToolCalls: 4 }))
  handle = await ctx.agents.create({ sessionId: 'notes-integration', meta: { agentPreset: 'codex' },
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup(agentCtx) {
      agentCtx.on('agent/error', ({ error }) => console.error(error.stack))
      mode.apply(agentCtx)
      tools.apply(agentCtx)
      compactor = new Compaction(agentCtx, {})
    } })
  handle.agent.followup(createUserMessage({ content: text('Original task context '.repeat(1200)), source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  if (requests.length !== 4) console.error(JSON.stringify(handle.agent.session.snapshotEvents().filter(e => !['user/message', 'agent/inbox/spliced'].includes(e.type)), null, 2))
  assert.equal(requests.length, 4, 'real loop must finish write → request → reset → read → answer')
  const session = handle.agent.session
  const state = readContextState(session)
  assert.equal(state.windows.length, 2)
  assert.equal(state.windows[1].kind, 'note-reset')
  assert.equal(state.freshNoteRevision, 0)
  assert.equal(state.noteRead, true)
  const resetInput = JSON.stringify(requests[2].messages)
  assert.match(resetInput, /codex-context-note-reset:v1/)
  assert.match(resetInput, /NEW CORRECTION/)
  assert.doesNotMatch(resetInput, /Original task context Original task context/)
  assert.doesNotMatch(resetInput, /"Current window: [^\n]*initial/)
  assert.ok(session.snapshotEvents().some(e => e.type === 'user/message' && JSON.stringify(e.data).includes('Original task context')))
  assert.ok(requests[2].messages.some(b => b.role === 'tool' && b.toolCallId === 'reset-1') || requests[2].messages.flatMap(m => m.content).some(b => b.type === 'tool-result' && b.toolCallId === 'reset-1'))
  assert.ok(requests[0].tools.some(tool => tool.name === 'new_context'), 'actual assembled tool catalog includes Notes')
  const history = tools.historyPage(session, { query: 'Original task context' })
  assert.equal(history.items[0].text.length, 8192)
  assert.ok(history.nextCursor)
  const nextHistory = tools.historyPage(session, { cursor: history.nextCursor })
  assert.ok(nextHistory.items[0].text.length > 0)
  await ctx.sessions.flush(session)
  const note = readActiveNote(session)
  await handle.dispose()
  handle = await ctx.agents.resume({ resumeSessionId: 'notes-integration',
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup(agentCtx) {
      mode.apply(agentCtx); tools.apply(agentCtx); new Compaction(agentCtx, {})
    } })
  assert.equal(readContextState(handle.agent.session).windowId, state.windowId)
  assert.equal(readActiveNote(handle.agent.session), note)
  assert.equal(handle.agent.session.surface.replaceGeneration, 1)
  await compactor.compactNow(handle.agent, new AbortController().signal)
  assert.equal(readContextState(handle.agent.session).windows.at(-1).kind, 'summary-fallback')
  assert.equal(readActiveNote(handle.agent.session), null)
  console.log('Notes integration: real DSH loop + JSONL persistence + meter + reset + steering + read + resume PASS')
} finally {
  await handle?.dispose()
  await ctx.fiber.dispose()
  if (previous === undefined) delete process.env.DSH_CODEX_CONTEXT_DIR
  else process.env.DSH_CODEX_CONTEXT_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
}
