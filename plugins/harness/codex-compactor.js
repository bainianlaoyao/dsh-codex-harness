/**
 * dsh-codex M2 — codex-semantics compaction backend (`ctx.compaction`).
 *
 * A drop-in `CompactionEngine` implementation that ports codex HEAD
 * 5bc8da6d78 compaction semantics (core/src/compact.rs) onto the DSH
 * compaction seam:
 *
 * - Trigger (`compactIfNeeded`): compact only when the DSH token pressure
 *   reaches the codex threshold — `shouldCompact()` from `./compact.js`
 *   (90 % of the routed model's context window plus an optional fallback
 *   buffer, or the full window). The `context-overflow` trigger bypasses the
 *   threshold because the provider has already confirmed overflow.
 * - Retention: the replacement user message keeps the NEWEST user messages
 *   within `maxRetainedTokens` (codex `COMPACT_USER_MESSAGE_MAX_TOKENS`,
 *   default 20,000), oldest truncated to the remaining budget; every
 *   assistant/tool message and every older user message is shadowed — the
 *   summary carries their state. This is codex `select_user_messages` +
 *   `build_compacted_history`, NOT the DSH "keep a recent priced tail"
 *   retention of compaction-basic.
 * - Summarization: one real `ctx.llm.stream()` call whose final user message
 *   is the verbatim `SUMMARIZATION_PROMPT` (system = the session persona, or
 *   none), reusing the routed provider/model. The summary text is the call's
 *   complete output text; the replacement appends it as the final user
 *   message framed by `SUMMARY_PREFIX` (`summaryMessage()` shape).
 *
 * The durable `compaction/start | summary | end` lifecycle, the `compaction/*`
 * event protocol, shadowed pricing, the replacement `user/message`
 * `surfaceOp.replace` with `compactCheckpointSource`, and the tool-pairing
 * balance guards are ported from `@deepseek-ai/dsh-compaction-basic`
 * (`compactSurfaceRegion` transaction); only the trigger policy, retention
 * rule, and summary prompt/framing are codex's.
 *
 * TOKEN-SOURCE DIFFERENCE (compaction-basic and codex):
 * - DSH pressure here is `ctx.tokenMeter.measure(session).totalTokens`: the
 *   token-meter's FIXED-DENSITY HEURISTIC (chars/4 plus per-block/role
 *   overhead, `@deepseek-ai/dsh-token-meter`) over the durable request
 *   envelope AND the surface, optionally anchored to provider usage. It
 *   prices request + response together.
 * - codex `active_context_tokens` is the TOKENIZER-ACCURATE count of the
 *   model-visible context (system + messages) of the CURRENT request, no
 *   response component.
 * The `shouldCompact` shape is applied to the DSH estimate, so the trigger is
 * an approximation of codex's: same 90 % window rule, different measuring
 * stick. The context window comes from `ctx.llm.resolveModelInfo(...)` and
 * falls back to `defaultContextWindow` when the adapter reports no capacity.
 *
 * @module dsh-codex/harness/codex-compactor
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  contentHasImage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import {
  SUMMARIZATION_PROMPT,
  approxTokens,
  selectUserMessages,
  shouldCompact,
  summaryMessage,
} from './compact.js'

/** Cordis plugin name used by loader diagnostics and the summary-call source tag. */
export const name = 'compaction-codex'
/** Services the engine needs; the loader waits for them before `apply`. */
export const inject = ['llm', 'tokenMeter', 'sessions']

/** Positive context capacity used when the routed model reports none (codex default window). */
const DEFAULT_CONTEXT_WINDOW = 400000
/** codex `COMPACT_USER_MESSAGE_MAX_TOKENS` — newest user messages retained verbatim. */
const DEFAULT_MAX_RETAINED_TOKENS = 20000
/** codex `fallback_buffer` default: no extra headroom above the 90 % limit. */
const DEFAULT_FALLBACK_BUFFER = 0
/** Overflow recovery attempts per agent before preserving the original request error. */
const MAX_OVERFLOW_RETRIES = 1

const defaultContextWindowSchema = z.number().step(1).min(1)
const fallbackBufferSchema = z.number().step(1).min(0)
const maxRetainedTokensSchema = z.number().step(1).min(1)

/** Plugin config; every field optional, defaults are the codex constants. */
export const Config = z.object({
  /** Model context window in tokens when the adapter reports no capacity (default 400000). */
  defaultContextWindow: defaultContextWindowSchema,
  /** Extra headroom added above the 90 % window limit before auto-compaction (default 0). */
  fallbackBuffer: fallbackBufferSchema,
  /** Token budget for the newest user messages retained in the replacement (default 20000). */
  maxRetainedTokens: maxRetainedTokensSchema,
})

/** Validate, detach, and apply defaults to untrusted plugin config. */
function resolveConfig(config = {}) {
  return {
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    fallbackBuffer: config.fallbackBuffer ?? DEFAULT_FALLBACK_BUFFER,
    maxRetainedTokens: config.maxRetainedTokens ?? DEFAULT_MAX_RETAINED_TOKENS,
  }
}

/** The latest durably routed provider/model, if any. */
function routedTarget(session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return
  return { provider: config.provider, model: config.model }
}

/** The agent-declared provider/model fallback for the summarization call. */
function agentTarget(agent) {
  if (agent.options.provider === undefined || agent.options.provider.length === 0 || agent.options.model === undefined || agent.options.model.length === 0) return
  return { provider: agent.options.provider, model: agent.options.model }
}

// ── summarization (codex prompt + full-output text) ────────────────────────

/**
 * Run the codex summarization call: replay the shadowed region's derived
 * messages, then append `SUMMARIZATION_PROMPT` as the FINAL user message so
 * the auxiliary call stays a prefix of the conversation (provider KV cache
 * reuse), exactly like compaction-basic's `summarizeWithLlm`.
 * @param ctx - context providing the LLM service.
 * @param input - replayed region (system, tools, messages) to condense.
 * @param agent - supplies the routed-model history and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks, the joined full output text, and the
 *   exact call envelope and output.
 */
async function summarizeWithLlm(ctx, input, agent, signal) {
  const latest = agent.session.requestHeader()?.config
  const target = latest ?? agentTarget(agent)
  if (target === undefined)
    throw new Error('compaction-codex: no provider/model available for summarization: route one request or set both AgentOptions fields')
  const assembler = new BlockAssembler()
  const messages = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: SUMMARIZATION_PROMPT }],
      source: { kind: 'plugin', plugin: name },
    }),
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const rawOutput = assembler.blocks()
  if (contentHasImage(rawOutput)) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  const summary = rawOutput.filter((block) => block.type === 'text')
  const summaryText = summary.map((block) => block.text).join('')
  if (summaryText.trim().length === 0) throw new Error('compaction-codex: summarization produced no text summary content')
  return {
    summary,
    summaryText,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('compaction-codex: summarization truncated at the token cap (incomplete summary)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default: return
  }
}

// ── codex retention over the surface ───────────────────────────────────────

/** Join the text blocks of one content list (adapter-flattening semantics). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/**
 * Collect the REAL user-message texts of a surface span, in surface order.
 * DSH projects `tool/result` events to user-role messages, so tool results
 * are excluded (codex keeps only `role == User` conversation messages; the
 * summary carries tool state).
 */
function collectUserTexts(session, shadowedSeqs) {
  const events = session.events
  const texts = []
  for (const seq of shadowedSeqs) {
    const message = session.deriveEventMessage(events[seq])
    if (message === null || message.role !== 'user') continue
    if (message.content.some((block) => block.type === 'tool-result')) continue
    const text = flattenText(message.content)
    if (text.length === 0) continue
    texts.push(text)
  }
  return texts
}

/**
 * Build the replacement user-message content: the retained user messages
 * (codex `selectUserMessages` semantics) followed by the summary message
 * (`SUMMARY_PREFIX` + the full summary text).
 * @param retained - `selectUserMessages().retained` entries, chronological.
 * @param summaryText - the complete summarization output text.
 */
function codexCheckpointContent(retained, summaryText) {
  const content = retained.map((entry) => ({ type: 'text', text: entry.text }))
  content.push({ type: 'text', text: summaryMessage(summaryText).text })
  return content
}

// ── region selection and the durable compaction transaction ────────────────

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from (distinguished from summarizer/shrink failures).
 */
class SurfaceChangedError extends Error {}

/**
 * Select the whole-surface span for a codex compaction: every surface node.
 * Declines when the surface is empty or the tail cut is not tool-pairing
 * balanced (an open tool call cannot be shadowed).
 */
function selectWholeSurfaceRange(session, measurement) {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq))
    throw new Error('compaction-codex: token-meter surface does not match the current session surface')
  const last = surfaceNodes[surfaceNodes.length - 1]
  if (!toolPairingBalancedAfter(session, last)) return null
  return { start: surfaceNodes[0], end: last }
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Ported from compaction-basic `compactSurfaceRegion`: selection and lock
 * validation are read-only, `compaction/start` is the durable lock, and every
 * later failure makes exactly one `compaction/end` attempt.
 */
async function compactSurfaceRegion(dependencies, session, start, end, agent, options, signal) {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'compaction')
  let owner
  if (options.owner === null) {
    if (entryState.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    owner = null
  } else {
    if (entryState.openTurn === null) throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    owner = entryState.openTurn
  }
  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  const assertStable = options.stability === 'whole-surface' ? assertWholeSurfaceUnchanged : assertSelectedSpanStable
  let failure
  let flushFailure
  let result
  let closed = false
  let closing = false
  let stage = 'summary'
  try {
    const summarized = await summarizeCompaction(
      dependencies,
      prepareCompaction(dependencies, session, selection),
      agent,
      compactionId,
      options.sourceCommandId,
      options.maxRetainedTokens,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
  } catch (error) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }
  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error) {
      flushFailure = error
    }
  }
  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure })
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction-codex: compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure) {
  if (failure.stage === 'commit') throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error })
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error })
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves its owner belongs to an earlier session lifecycle.
 */
function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
  if (unmatchedCompactionStart === undefined || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`)
}

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Snapshot pricing and replay input for a validated surface range. */
function prepareCompaction(dependencies, session, selection) {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index]))
    throw new SurfaceChangedError('compaction-codex: selected surface changed before summarization began')
  return {
    ...selection,
    measurement,
    selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/**
 * Run the summarizer and assemble the codex checkpoint replacement: the
 * retained user messages (codex `selectUserMessages`) plus the summary message.
 */
async function summarizeCompaction(dependencies, prepared, agent, compactionId, sourceCommandId, maxRetainedTokens, signal) {
  const summaryResult = await dependencies.summarize(prepared.input, agent, signal)
  const texts = collectUserTexts(agent.session, prepared.shadowedSeqs)
  const { retained } = selectUserMessages(texts, { maxTokens: maxRetainedTokens, estimate: approxTokens })
  const checkpointMessage = createUserMessage({
    content: codexCheckpointContent(retained, summaryResult.summaryText),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
  if (framedSummaryTokenCount >= prepared.shadowedTokenCount)
    throw new Error(`compaction-codex: summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedTokenCount})`)
  return { ...prepared, ...summaryResult, checkpointMessage }
}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(dependencies, session, prepared) {
  if (!isDeepStrictEqual(dependencies.meter.measure(session).nodes, prepared.measurement.nodes))
    throw new SurfaceChangedError('compaction-codex: session surface changed during summarization')
}

/** Require only that the selected span remain the same present, contiguous, equally priced, balanced replacement target. */
function assertSelectedSpanStable(dependencies, session, prepared) {
  let current
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error) {
    throw new SurfaceChangedError('compaction-codex: the selected span is no longer a valid replacement target', { cause: error })
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) throw new SurfaceChangedError('compaction-codex: the selected span changed during summarization')
  if (!isDeepStrictEqual(dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes))
    throw new SurfaceChangedError('compaction-codex: the selected span was rewritten during summarization')
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(session, startEvent, summarized) {
  const { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, maxTokens, usage, checkpointMessage } = summarized
  const callProvenance = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
    summary,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(usage === undefined ? {} : { usage }),
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  return {
    compactionId: startEvent.data.compactionId,
    ...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(pending, endEvent) {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * Reconstruct the shadowed region's cacheable prefix: its system prompt and
 * tool schemas, then the region's own derived messages in surface order.
 */
function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader()
  const events = session.events
  const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(events[seq])).filter((message) => message !== null)
  return {
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: regionMessages,
  }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(events) {
  let openTurn = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart
  let compactionEntryStateKnown = false
  let latestEndSeedSeq
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') compactionEntryStateKnown = true
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') openTurnStateKnown = true
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

// ── engine ─────────────────────────────────────────────────────────────────

/**
 * Codex-semantics compaction backend: whole-surface replacement that keeps the
 * newest user messages and one `SUMMARY_PREFIX` summary message, driven by the
 * codex 90 % trigger on the DSH token-meter pressure estimate.
 */
export class CodexCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config = Config

  /** Resolved and validated compaction configuration. */
  config
  /** Per-agent overflow recovery attempt counters. */
  overflowRetries = new WeakMap()
  /** Session → agent mapping for overflow state reset on new assistant content. */
  overflowAgents = new WeakMap()

  constructor(ctx, config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  _registerAutomaticCompaction() {
    const { ctx } = this
    const logResult = (result, trigger) => {
      ctx.logger.info(`compaction-codex (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`)
    }
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= MAX_OVERFLOW_RETRIES) return next()
      const generation = agent.session.surface.replaceGeneration
      let result
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(`context-overflow compaction failed: ${message}; preserving the original request error`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed region through one direct `ctx.llm.stream()` call
   * whose final user message is the codex `SUMMARIZATION_PROMPT`.
   * @param input - replayed conversation prefix (system, tools, messages).
   * @param agent - supplies routed-model history and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   */
  async summarize(input, agent, signal) {
    return summarizeWithLlm(this.ctx, input, agent, signal)
  }

  /**
   * Compact for step-boundary pressure or provider-confirmed context overflow.
   * codex semantics: pressure compacts only at the `shouldCompact` threshold
   * (90 % window); overflow bypasses the threshold. The replacement follows
   * codex retention: newest user messages within `maxRetainedTokens`, then the
   * summary message, shadowing the entire surface.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the compaction result, or `null` when no compaction ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    if (trigger === 'pressure') {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      const contextWindow = info?.context?.contextWindow ?? this.config.defaultContextWindow
      const measurement = this.ctx.tokenMeter.measure(agent.session)
      if (!shouldCompact({ activeTokens: measurement.totalTokens, contextWindow, fallbackBuffer: this.config.fallbackBuffer })) return null
    } else if (trigger !== 'context-overflow') {
      throw new Error(`compaction-codex: unknown compaction trigger ${String(trigger)}`)
    }
    const range = selectWholeSurfaceRange(agent.session, this.ctx.tokenMeter.measure(agent.session))
    if (range === null) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * codex retention over that span's own user messages.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  async compactRegion(start, end, agent, signal) {
    return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
      owner: 'current-turn',
      stability: 'whole-surface',
      maxRetainedTokens: this.config.maxRetainedTokens,
    }, signal)
  }

  /**
   * Force one idle-session compaction below the pressure threshold (codex
   * `run_compact_task` semantics), resolving only after its standalone marker
   * pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectWholeSurfaceRange(agent.session, this.ctx.tokenMeter.measure(agent.session))
          if (range === null) return null
          return await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {
            owner: null,
            stability: 'selected-span',
            ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            maxRetainedTokens: this.config.maxRetainedTokens,
            flush: async () => {
              await this.ctx.sessions.flush(agent.session)
            },
          }, operationSignal)
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error })
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  regionDependencies() {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }
}

// ── cordis registration ────────────────────────────────────────────────────

/**
 * Register `ctx.compaction` with the codex engine. The `CompactionEngine`
 * base constructor (`super(ctx, 'compaction')`) performs the actual service
 * registration; `ctx.plugin` wires lifecycle and validated config, mirroring
 * the documented compaction-basic usage.
 */
export function apply(ctx, config) {
  ctx.plugin(CodexCompactionEngine, config)
}
