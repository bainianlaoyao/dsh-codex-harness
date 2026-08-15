/**
 * Smoke test for dsh-codex/harness/codex-compactor.js — the codex-semantics
 * `ctx.compaction` backend: ① no compaction below the 90 % threshold,
 * ② summarization + codex retained-user-message replacement + complete
 * CompactionResult above it, ③ SUMMARIZATION_PROMPT in the summary call,
 * ④ compactNow happy path. The session, token meter, and llm seam are mocked;
 * the real `toolPairingBalanced*` helpers from @deepseek-ai/dsh-compaction run
 * against the mock session surface.
 *
 * Usage: node dsh-codex/harness/codex-compactor.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'
import { apply, Config, CodexCompactionEngine, name } from './codex-compactor.js'
import { SUMMARIZATION_PROMPT, SUMMARY_PREFIX, TRUNCATION_NOTICE, approxTokens, selectUserMessages } from './compact.js'

// ── mock seams ─────────────────────────────────────────────────────────────

const HEADER = {
  config: { provider: 'p', model: 'm' },
  system: 'persona',
  tools: [{ name: 't1', description: 'd', parameters: { type: 'object', properties: {} } }],
}

function textBlock(text) {
  return { type: 'text', text }
}

function blockText(block) {
  if (block.type === 'text') return block.text
  if (block.type === 'tool-result') return (block.content ?? []).map(blockText).join('')
  return ''
}

function messageText(message) {
  return (message?.content ?? []).map(blockText).join('')
}

function userEvent(text) {
  return {
    type: 'user/message',
    data: { role: 'user', content: [textBlock(text)], source: { kind: 'user' } },
    surfaceOp: 'append',
    time: 1,
  }
}

function assistantEvent(text, toolCall) {
  const content = [textBlock(text)]
  if (toolCall !== undefined) content.push({ type: 'tool-call', id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })
  return {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } } },
    surfaceOp: 'append',
    time: 1,
  }
}

function toolResultEvent(callId, text) {
  return {
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [textBlock(text)], isError: false }],
        source: { kind: 'tool', callId },
      },
    },
    surfaceOp: 'append',
    time: 1,
  }
}

/**
 * Build a mock Session shaped like the real @deepseek-ai/dsh-session surface:
 * a seq-indexed event log, a live `surface.nodes` projection (append/replace),
 * requestHeader, deriveEventMessage, and append.
 */
function makeSession({ userTexts, assistantTexts, withTurn = true, header = HEADER }) {
  const log = []
  const surface = { nodes: [], replaceGeneration: 0 }
  const session = {
    id: 'smoke-session',
    surface,
    get events() {
      return log
    },
    get seq() {
      return log.length
    },
    requestHeader: () => header,
    deriveEventMessage(event) {
      switch (event.type) {
        case 'user/message':
          return event.data
        case 'assistant/message':
          return event.data.message.content.length === 0 ? null : event.data.message
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
    append(type, data, opts) {
      const event = { seq: log.length, type, data, time: Date.now(), ...(opts === undefined ? {} : opts) }
      log.push(event)
      const op = opts?.surfaceOp
      if (op === 'append') {
        surface.nodes.push(event.seq)
      } else if (op?.op === 'replace') {
        const startIdx = surface.nodes.indexOf(op.start)
        const endIdx = surface.nodes.indexOf(op.end)
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error(`mock append: bad replace span ${op.start}..${op.end}`)
        surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
        surface.replaceGeneration += 1
      } else if (op === undefined) {
        // log-only event (turn boundaries, compaction markers)
      } else {
        surface.nodes.push(event.seq)
      }
      return event
    },
  }
  const push = (event) => {
    event.seq = log.length
    log.push(event)
    surface.nodes.push(event.seq)
    return event
  }
  if (withTurn) log.push({ seq: 0, type: 'turn/start', data: { turn: 1 }, time: 1 })
  userTexts.forEach((text) => push(userEvent(text)))
  assistantTexts.forEach((text, index) => push(assistantEvent(text, index === 1 ? { id: 'call-1', name: 'tool', arguments: '{}' } : undefined)))
  push(toolResultEvent('call-1', 'tool output'))
  return session
}

/** Token meter mock: fixed bytes/4 estimate plus role overhead per node. */
function makeTokenMeter() {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => {
        const message = session.deriveEventMessage(session.events[seq])
        return { seq, tokens: message === null ? 0 : approxTokens(messageText(message)) + 4 }
      })
      const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      const header = session.requestHeader()
      const headerTokens = header?.system === undefined || header.system.length === 0 ? 0 : Math.ceil(header.system.length / 4) + 4
      return {
        logRevision: session.events.length,
        baseline: { kind: 'estimated', tokens: 0 },
        surfaceDeltaTokens: 0,
        totalTokens: surfaceTokens + headerTokens,
        surfaceTokens,
        nodes,
      }
    },
    estimateMessage(message) {
      return approxTokens(messageText(message)) + 4
    },
  }
}

/** LLM seam mock: records every stream call, emits one fixed text block. */
function makeLlm({ contextWindow = 1000, summaryText = 'SUMMARY OUTPUT' } = {}) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow } }
    },
    async *stream(options) {
      calls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summaryText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summaryText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** Minimal cordis ctx: service properties, reflect.provide, on, logger, plugin. */
function makeCtx({ llm, tokenMeter, sessions }) {
  const provided = {}
  const listeners = []
  const ctx = {
    llm,
    tokenMeter,
    sessions,
    get: (svc) => ({ llm, tokenMeter, sessions })[svc],
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    plugin(cls, config) {
      const instance = new cls(ctx, config)
      provided[instance.name] = instance
      return { dispose: () => {} }
    },
    reflect: {
      provide(svc, value) {
        provided[svc] = value
      },
    },
  }
  return { ctx, provided, listeners }
}

function makeAgent(session) {
  let maintenanceCalls = 0
  const agent = {
    session,
    options: { provider: 'openai-official', model: 'gpt-5.1-codex' },
    maintenanceCalls: () => maintenanceCalls,
    async runMaintenance(task) {
      maintenanceCalls += 1
      return task(new AbortController().signal)
    },
  }
  return agent
}

// ── fixtures ───────────────────────────────────────────────────────────────

const U0 = 'x'.repeat(80) // ≈20 tokens each user message
const U1 = 'y'.repeat(80)
const U2 = 'z'.repeat(80)
// Below threshold: total ≈ 3*24 + 3*54 + 19 + 6 ≈ 259 < 900.
const SMALL_ASSISTANTS = ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)]
// Above threshold: total ≈ 3*24 + 3*304 + 19 + 6 ≈ 1009 >= 900.
const BIG_ASSISTANTS = ['a'.repeat(1200), 'b'.repeat(1200), 'c'.repeat(1200)]

// ── plugin identity / config ───────────────────────────────────────────────

assert.equal(name, 'compaction-codex')
assert.ok(Config instanceof Object)
assert.equal(CodexCompactionEngine.name, 'CodexCompactionEngine')

// ── ① below threshold → null, no summary call ──────────────────────────────

{
  const session = makeSession({ userTexts: [U0, U1, U2], assistantTexts: SMALL_ASSISTANTS })
  const agent = makeAgent(session)
  const llm = makeLlm()
  const { ctx } = makeCtx({ llm, tokenMeter: makeTokenMeter(), sessions: { flush: async () => {} } })
  const engine = new CodexCompactionEngine(ctx, { defaultContextWindow: 1000, fallbackBuffer: 0, maxRetainedTokens: 20000 })
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.equal(result, null, 'below threshold must not compact')
  assert.equal(llm.calls.length, 0, 'no summarization call below threshold')
  assert.ok(session.events.every((event) => event.type !== 'compaction/start'), 'no durable lifecycle below threshold')
}

// ── ②/③ above threshold → codex retention replacement + full result ────────

{
  const session = makeSession({ userTexts: [U0, U1, U2], assistantTexts: BIG_ASSISTANTS })
  const agent = makeAgent(session)
  const llm = makeLlm()
  const tokenMeter = makeTokenMeter()
  const flushed = []
  const { ctx } = makeCtx({ llm, tokenMeter, sessions: { flush: async (s) => flushed.push(s.id) } })
  const engine = new CodexCompactionEngine(ctx, { defaultContextWindow: 1000, fallbackBuffer: 0, maxRetainedTokens: 20000 })

  const expectedShadowed = tokenMeter.measure(session).nodes.reduce((sum, node) => sum + node.tokens, 0)
  const nodesBefore = [...session.surface.nodes]
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)

  // Trigger actually fired.
  assert.ok(result !== null, 'above threshold must compact')

  // ③ SUMMARIZATION_PROMPT is the final user message of the summary call.
  assert.equal(llm.calls.length, 1, 'exactly one summarization call')
  const call = llm.calls[0]
  assert.equal(call.provider, 'p', 'routed provider reused')
  assert.equal(call.model, 'm', 'routed model reused')
  assert.equal(call.purpose, 'compaction')
  assert.equal(call.system, 'persona', 'session persona reused as the summarizer system')
  assert.equal(call.messages.length, nodesBefore.length + 1, 'surface messages replayed plus the prompt')
  const promptMessage = call.messages[call.messages.length - 1]
  assert.equal(promptMessage.role, 'user')
  assert.equal(promptMessage.content[0].text, SUMMARIZATION_PROMPT, 'SUMMARIZATION_PROMPT is the summary call user message')

  // Durable lifecycle in contract order.
  const types = session.events.map((event) => event.type)
  const startIdx = types.indexOf('compaction/start')
  const summaryIdx = types.indexOf('compaction/summary')
  const endIdx = types.indexOf('compaction/end')
  const replIdx = types.findIndex((type, index) => type === 'user/message' && session.events[index].surfaceOp?.op === 'replace')
  assert.ok(startIdx !== -1 && summaryIdx !== -1 && endIdx !== -1 && replIdx !== -1)
  assert.ok(startIdx < summaryIdx && summaryIdx < replIdx && replIdx < endIdx, 'start < summary < replacement < end')

  const startEvent = session.events[startIdx]
  const summaryEvent = session.events[summaryIdx]
  const replEvent = session.events[replIdx]
  const endEvent = session.events[endIdx]

  // summary event: llmStreamCall provenance + shadowed pricing (protocol).
  assert.equal(summaryEvent.data.llmStreamCall, true)
  assert.deepEqual(summaryEvent.data.rawOutput, [{ type: 'text', text: 'SUMMARY OUTPUT' }])
  assert.deepEqual(summaryEvent.data.summary, [{ type: 'text', text: 'SUMMARY OUTPUT' }])
  assert.deepEqual(summaryEvent.data.shadowedRange, { start: nodesBefore[0], end: nodesBefore[nodesBefore.length - 1] })
  assert.deepEqual(summaryEvent.data.shadowedSeqs, nodesBefore)
  assert.equal(summaryEvent.data.shadowedTokenCount, expectedShadowed)
  assert.equal(summaryEvent.data.provider, 'p')
  assert.equal(summaryEvent.data.model, 'm')
  assert.equal(summaryEvent.data.compactionId, startEvent.data.compactionId)

  // Replacement user message: retained user messages + summary message.
  assert.deepEqual(replEvent.surfaceOp, { op: 'replace', start: nodesBefore[0], end: nodesBefore[nodesBefore.length - 1] })
  assert.deepEqual(replEvent.sourceEventSeqs, [startEvent.seq, summaryEvent.seq, ...nodesBefore])
  const replContent = replEvent.data.content
  assert.deepEqual(
    replContent.map((block) => block.text),
    [U0, U1, U2, `${SUMMARY_PREFIX}\nSUMMARY OUTPUT`],
    'replacement = retained user messages then SUMMARY_PREFIX summary',
  )
  assert.equal(replEvent.data.role, 'user')
  assert.equal(replEvent.data.source.kind, 'plugin')
  assert.equal(replEvent.data.source.plugin, 'compact')
  assert.equal(replEvent.data.source.compactionId, startEvent.data.compactionId)

  // CompactionResult fields complete.
  assert.equal(result.compactionId, startEvent.data.compactionId)
  assert.equal(result.startSeq, startEvent.seq)
  assert.equal(result.summarySeq, summaryEvent.seq)
  assert.equal(result.endSeq, endEvent.seq)
  assert.deepEqual(result.summary, [{ type: 'text', text: 'SUMMARY OUTPUT' }])
  assert.deepEqual(result.shadowedRange, { start: nodesBefore[0], end: nodesBefore[nodesBefore.length - 1] })
  assert.deepEqual(result.shadowedSeqs, nodesBefore)
  assert.equal(result.shadowedTokenCount, expectedShadowed)
  assert.ok(typeof result.compactionId === 'string' && result.compactionId.length > 0)

  // The whole surface is replaced by the single checkpoint node.
  assert.deepEqual(session.surface.nodes, [replEvent.seq], 'entire surface shadowed by the replacement')
  assert.equal(endEvent.data.turn, 1, 'automatic compaction enclosed in the open turn')
}

// ── ②b codex retention matches selectUserMessages (oldest truncated/dropped) ─

{
  const session = makeSession({ userTexts: [U0, U1, U2], assistantTexts: BIG_ASSISTANTS })
  const agent = makeAgent(session)
  const llm = makeLlm()
  const { ctx } = makeCtx({ llm, tokenMeter: makeTokenMeter(), sessions: { flush: async () => {} } })
  const engine = new CodexCompactionEngine(ctx, { defaultContextWindow: 1000, fallbackBuffer: 0, maxRetainedTokens: 30 })
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.ok(result !== null)

  const expected = selectUserMessages([U0, U1, U2], { maxTokens: 30, estimate: approxTokens })
  assert.equal(expected.dropped, 1, 'oldest user message dropped under a 30-token budget')
  assert.equal(expected.retained.length, 2)
  assert.equal(expected.retained[0].truncated, true, 'oldest retained message truncated to the remaining budget')

  const replEvent = session.events.find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
  const contentTexts = replEvent.data.content.map((block) => block.text)
  assert.equal(contentTexts[0], expected.retained[0].text, 'replacement carries the truncated oldest retained message')
  assert.ok(contentTexts[0].includes(TRUNCATION_NOTICE))
  assert.equal(contentTexts[1], expected.retained[1].text, 'replacement carries the newest retained message')
  assert.equal(contentTexts[2], `${SUMMARY_PREFIX}\nSUMMARY OUTPUT`, 'summary message appended last')
  assert.ok(!contentTexts.join('').includes(U0), 'dropped oldest message absent from the replacement')
}

// ── ④ compactNow happy path (manual /compact semantics) ────────────────────

{
  const session = makeSession({ userTexts: [U0, U1, U2], assistantTexts: BIG_ASSISTANTS, withTurn: false })
  const agent = makeAgent(session)
  const llm = makeLlm()
  const flushed = []
  const { ctx } = makeCtx({ llm, tokenMeter: makeTokenMeter(), sessions: { flush: async (s) => flushed.push(s.id) } })
  const engine = new CodexCompactionEngine(ctx, { defaultContextWindow: 1000, fallbackBuffer: 0, maxRetainedTokens: 20000 })

  const result = await engine.compactNow(agent, new AbortController().signal, 'command-42')
  assert.ok(result !== null, 'compactNow compacts an idle session')
  assert.equal(agent.maintenanceCalls(), 1, 'runMaintenance reserved idle admission once')
  assert.deepEqual(flushed, ['smoke-session'], 'durability checkpoint flushed the session')
  assert.equal(result.sourceCommandId, 'command-42')

  const startEvent = session.events.find((event) => event.type === 'compaction/start')
  const summaryEvent = session.events.find((event) => event.type === 'compaction/summary')
  const endEvent = session.events.find((event) => event.type === 'compaction/end')
  assert.equal(startEvent.data.turn, null, 'manual transaction is a standalone marker pair')
  assert.ok(!('turn' in summaryEvent.data), 'summary event has no turn field (start/end do — protocol shape)')
  assert.equal(endEvent.data.turn, null)
  assert.equal(summaryEvent.data.sourceCommandId, 'command-42')
  assert.equal(summaryEvent.data.llmStreamCall, true)
  assert.equal(result.endSeq, endEvent.seq)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].messages.at(-1).content[0].text, SUMMARIZATION_PROMPT)
}

// ── apply registers ctx.compaction ─────────────────────────────────────────

{
  const llm = makeLlm()
  const { ctx, provided } = makeCtx({ llm, tokenMeter: makeTokenMeter(), sessions: { flush: async () => {} } })
  apply(ctx, { defaultContextWindow: 1000 })
  assert.ok(provided.compaction instanceof CodexCompactionEngine, 'apply registers the codex engine as ctx.compaction')
}

console.log('codex-compactor smoke test: ALL PASS')
