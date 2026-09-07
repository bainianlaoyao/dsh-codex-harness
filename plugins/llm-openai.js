/**
 * dsh-codex M0 — OpenAI chat-completions adapter for the DSH `llm` seam.
 *
 * Registers the `openai-official` provider route (baseURL-configurable for
 * OpenAI-compatible endpoints) so GPT-family models (gpt-5.x / gpt-5.1-codex /
 * o-series) can drive the harness. Wire protocol: OpenAI Chat Completions
 * with SSE streaming (`stream_options.include_usage`), reasoning_effort
 * mapping, and `max_completion_tokens` output caps.
 *
 * A later milestone (M2) may add the Responses-API wire for closer codex
 * request parity; this adapter keeps the wire confined to `request()` so a
 * second wire can slot in beside it.
 *
 * Plain JavaScript (ESM), no build step, no runtime dependencies beyond the
 * harness packages hoisted in the profile node_modules. The SSE parser is
 * inlined to stay dependency-free.
 *
 * @module dsh-codex/llm-openai
 */

import {
  ToolCallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-openai'
/** The LLM registry this adapter registers into. */
export const inject = ['llm']

/** The single provider route this plugin owns. */
const PROVIDER = 'openai-official'
/** Public API default; `baseURL` config overrides it for compatible endpoints. */
const PUBLIC_BASE_URL = 'https://api.openai.com/v1'
/** Default environment variable holding the API key. */
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
/** Plugin display name in provider selectors. */
const DISPLAY_NAME = 'OpenAI'
/** Settings namespace the web Models page can layer this plugin under. */
const SETTINGS_NS = 'llm-openai'

/** Wire-accepted reasoning efforts (gpt-5 family / o-series). */
const WIRE_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])

// ── configuration schema ───────────────────────────────────────────────────

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

/** Plugin config; defaults are advisory and every field is optional. */
export const Config = z.object({
  /** Credential reference (environment-variable name); defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: z.string(),
  /** Endpoint base; defaults to the public OpenAI API. */
  baseURL: z.string(),
  /** Default reasoning effort when the caller omits one (default `high`). */
  defaultReasoningEffort: z.string(),
  /** Default per-request output cap (default 32,000); model entries and explicit requests win. */
  defaultMaxTokens: z.number().step(1).min(1),
  /** Positive context capacity used when the selected model has no exact entry (default 400,000). */
  defaultContextWindow: z.number().step(1).min(1),
  /** Output-cap wire field: `max_completion_tokens` (gpt-5/o-series) or `max_tokens`. */
  maxTokensField: z.union([z.const('max_completion_tokens'), z.const('max_tokens')]),
  /** Advisory models shown by discovery consumers. */
  models: z.array(catalogModel),
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy: RetryPolicySchema,
})

/** Default catalog: GPT-family models in adapter-preferred order. */
const DEFAULT_MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1-Codex', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1-Codex-Mini', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5-mini', name: 'GPT-5-mini', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-5-nano', name: 'GPT-5-nano', contextWindow: 400000, maxTokens: 32000 },
  { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576, maxTokens: 32768 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1-mini', contextWindow: 1047576, maxTokens: 32768 },
  { id: 'o3', name: 'o3', contextWindow: 200000, maxTokens: 100000 },
  { id: 'o4-mini', name: 'o4-mini', contextWindow: 200000, maxTokens: 100000 },
]

// ── connection facts ───────────────────────────────────────────────────────

function resolveOptions(config) {
  const models = (config.models ?? DEFAULT_MODELS).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
  return {
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config.baseURL ?? PUBLIC_BASE_URL,
    defaultReasoningEffort: config.defaultReasoningEffort ?? 'high',
    defaultMaxTokens: config.defaultMaxTokens ?? 32000,
    defaultContextWindow: config.defaultContextWindow ?? 400000,
    maxTokensField: config.maxTokensField ?? 'max_completion_tokens',
    models,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-openai: retryPolicy'),
  }
}

// ── wire serialization ─────────────────────────────────────────────────────

/** Join the text blocks of a message. */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Serialize harness messages into OpenAI chat-completions messages.
 * Image blocks become `image_url` content parts: the adapter resolves each
 * attachment through the attachment store (bytes → data URL) before the wire
 * request is built. Tool results flatten to text.
 */
async function serializeMessages(messages, attachments, signal) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const images = message.content.filter((block) => block.type === 'image')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0 || images.length > 0) {
      if (images.length === 0) {
        wire.push({ role: 'user', content: text })
      } else {
        const parts = []
        if (text.length > 0) parts.push({ type: 'text', text })
        for (const image of images) {
          if (attachments === undefined)
            throw new LlmError('The OpenAI adapter received an image but no attachment service is mounted.', 'UNSUPPORTED_CONTENT')
          const stored = await attachments.readImage(image.attachment, signal)
          const url = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
          parts.push({ type: 'image_url', image_url: { url, detail: 'high' } })
        }
        wire.push({ role: 'user', content: parts })
      }
    }
    for (const result of toolResults)
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
  }
  return wire
}

/** Validate the adapter-owned effort before putting it on the wire. */
function resolveEffort(options, defaults) {
  if (options.purpose === 'session-title') return undefined
  const effort = options.reasoningEffort === undefined ? defaults.defaultReasoningEffort : String(options.reasoningEffort)
  if (!WIRE_REASONING_EFFORTS.has(effort))
    throw new LlmError(`OpenAI does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  return effort
}

/** Build the full wire request body (async: image attachments resolve first). */
async function buildRequest(options, defaults, attachments) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...(await serializeMessages(options.messages, attachments, options.signal)))
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const effort = resolveEffort(options, defaults)
  const maxTokens = options.maxTokens === undefined ? {} : { [defaults.maxTokensField]: options.maxTokens }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...maxTokens,
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

// ── SSE parsing (dependency-free) ──────────────────────────────────────────

/**
 * Parse an OpenAI SSE byte stream into data payloads. Yields `[DONE]` as the
 * final value and returns; throws `STREAM_CLOSED` when the stream ends without
 * it (a truncated response cannot be trusted).
 */
async function* parseSse(stream) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart()
        yield data
        if (data === '[DONE]') return
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trimStart()
    yield data
    if (data === '[DONE]') return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

// ── SSE translation ────────────────────────────────────────────────────────

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function closeBlock(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * block-ends, usage, and finish are deferred to the `[DONE]` sentinel; a stop
 * finish with no opened blocks maps to an EMPTY_RESPONSE error finish.
 */
async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason:
          reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
            : reason,
      }
      return
    }
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

// ── error mapping ──────────────────────────────────────────────────────────

function providerRetryAfterMs(value) {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers) {
  const value = headers.get('x-request-id') ?? headers.get('openai-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

// ── adapter ────────────────────────────────────────────────────────────────

/**
 * `OpenAIAdapter`: fetch + SSE against an OpenAI chat-completions endpoint,
 * emitting harness StreamChunks. Transport-only: connection facts arrive
 * through a thunk and the bearer token through a per-request resolver.
 */
class OpenAIAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }
  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy
  }
  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)))
  }
  resolveModel(provider, model, _signal) {
    const connection = this.config.options()
    const configured = connection.models.find((entry) => entry.id === model)
    return Promise.resolve({
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text'] }
        : modelInfo(provider, configured)),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.defaultMaxTokens,
      reasoning: {
        efforts: EFFORTS,
        defaultEffort: EFFORT_BY_ID[connection.defaultReasoningEffort] ?? HIGH_REASONING_EFFORT,
      },
    })
  }
  async *stream(options) {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const body = await buildRequest(options, connection, this.config.attachments())
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      ...(options.sessionId === undefined ? {} : { 'x-dsh-harness-session-id': String(options.sessionId) }),
    }
    let response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('OpenAI request aborted by caller', 'ABORTED', { cause: error })
      throw new LlmError(`OpenAI API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `OpenAI API error (HTTP ${response.status})`
      let providerError
      try {
        providerError = (await response.json()).error
        if (providerError?.message) message = providerError.message
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      })
    }
    if (!response.body) throw new LlmError('OpenAI API returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body))
  }
}

// ── metadata helpers ───────────────────────────────────────────────────────

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: ['text'],
    context: { contextWindow: model.contextWindow },
  }
}

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'].map((effort) => ({
  id: ReasoningEffortId(effort),
  name: effort,
}))
const EFFORT_BY_ID = Object.fromEntries(EFFORTS.map((entry) => [entry.id, entry.id]))
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')

// ── plugin assembly ────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const options = () => {
    try {
      return resolveOptions(config)
    } catch (error) {
      ctx.logger?.error('llm-openai: invalid configuration')
      ctx.logger?.error(error)
      throw error
    }
  }
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-openai', ref)
    }
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return assertUsableApiKey(ambient, 'llm-openai', ref)
    throw new LlmError(
      `llm-openai: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL'
    )
  }
  const adapter = new OpenAIAdapter({ options, resolveApiKey, attachments: () => ctx.get('attachments') })
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: [] }])
  ctx.llm.registerAdapter([PROVIDER], adapter)
}

export { OpenAIAdapter, PUBLIC_BASE_URL }
