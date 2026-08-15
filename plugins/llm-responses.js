/**
 * dsh-codex — OpenAI Responses-API adapter for the DSH `llm` seam.
 *
 * Registers the `openai-responses` provider route so GPT-family models
 * (gpt-5.x / gpt-5.1-codex / o-series) drive the harness over the exact wire
 * codex CLI HEAD uses (`POST /v1/responses`, SSE). This route exists to make
 * `apply_patch` FAITHFULLY freeform: the tool is declared as a Responses
 * `custom` tool with codex's own lark grammar, the model emits the raw patch
 * text (no JSON), and only the adapter wraps it into the harness's internal
 * JSON-arguments transport (`{"patch": ...}`) so the DSH tool loop can run it.
 *
 * Wire parity with codex HEAD 5bc8da6d78:
 * - tools: `apply_patch` → `{type:'custom', format:{type:'grammar',syntax:'lark',
 *   definition:<apply_patch.lark>}}` with the verbatim description
 *   (codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20); every other
 *   tool → `{type:'function', strict:false}` (codex-rs/tools/src/responses_api.rs:161).
 * - history items: function_call / custom_tool_call / function_call_output /
 *   custom_tool_call_output, tagged snake_case (codex-rs/protocol/src/models.rs:844-846).
 * - SSE: output_text.delta, function_call_arguments.delta, custom_tool_call_input.delta,
 *   output_item.done, response.completed / failed / incomplete
 *   (codex-rs/codex-api/src/sse/responses.rs).
 * - usage: input_tokens + input_tokens_details{cached_tokens,cache_write_tokens}
 *   + output_tokens_details{reasoning_tokens}; cached input is subtracted from
 *   inputTokens to satisfy the harness's disjoint-count contract.
 *
 * Chat-completions remains available as the `openai-official` route
 * (llm-openai.js); on that wire the same apply_patch tool degrades to a JSON
 * function call because chat-completions has no custom-tool type.
 *
 * Plain JavaScript (ESM), no build step, dependency-free SSE parser.
 *
 * @module dsh-codex/llm-responses
 */

import {
  CallId,
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
export const name = 'llm-responses'
/** The LLM registry this adapter registers into. */
export const inject = ['llm']

/** The single provider route this plugin owns. */
const PROVIDER = 'openai-responses'
/** Public API default; `baseURL` config overrides it for compatible endpoints. */
const PUBLIC_BASE_URL = 'https://api.openai.com/v1'
/** Default environment variable holding the API key. */
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
/** Plugin display name in provider selectors. */
const DISPLAY_NAME = 'OpenAI Responses'
/** Settings namespace the web Models page can layer this plugin under. */
const SETTINGS_NS = 'llm-responses'

/** Wire-accepted reasoning efforts (gpt-5 family / o-series). */
const WIRE_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])

// ── freeform apply_patch (codex verbatim) ─────────────────────────────────

/**
 * Verbatim tool description from codex HEAD 5bc8da6d78
 * (codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20).
 */
const APPLY_PATCH_DESCRIPTION =
  'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.'

/**
 * Verbatim lark grammar from codex HEAD 5bc8da6d78
 * (codex-rs/core/src/tools/handlers/apply_patch.lark, the
 * `include_environment_id: false` form — this harness has no environment id).
 */
const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

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
  /** Tool names declared as Responses `custom` freeform tools (default `['apply_patch']`). */
  freeformTools: z.array(z.string()),
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
    freeformTools: new Set(config.freeformTools ?? ['apply_patch']),
    models,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-responses: retryPolicy'),
  }
}

// ── wire serialization ─────────────────────────────────────────────────────

/** Join the text blocks of a message. */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/**
 * Unwrap a freeform tool call's harness-side arguments into the raw freeform
 * text the model actually emitted: `{patch: raw}` → raw. Falls back to the raw
 * JSON string itself when the args do not parse (defensive; the adapter always
 * emits valid JSON on this route).
 */
function freeformInput(block) {
  try {
    const parsed = JSON.parse(block.arguments)
    if (typeof parsed === 'string') return parsed
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.patch === 'string') return parsed.patch
  } catch {}
  return block.arguments
}

/**
 * Serialize harness messages into Responses-API `input` items plus the
 * `instructions` slot. Assistant tool calls become function_call /
 * custom_tool_call items (freeform names by argument shape), tool results
 * become function_call_output / custom_tool_call_output — the exact item
 * vocabulary codex uses (codex-rs/protocol/src/models.rs:844-846).
 */
async function serializeInput(messages, attachments, freeformTools, signal) {
  const instructions = []
  const items = []
  const customCallIds = new Set()
  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) instructions.push(text)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      if (text.length > 0) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const call of message.content.filter((block) => block.type === 'tool-call')) {
        if (freeformTools.has(call.name)) {
          customCallIds.add(String(call.id))
          items.push({
            type: 'custom_tool_call',
            call_id: String(call.id),
            name: call.name,
            input: freeformInput(call),
          })
        } else {
          items.push({ type: 'function_call', call_id: String(call.id), name: call.name, arguments: call.arguments })
        }
      }
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const images = message.content.filter((block) => block.type === 'image')
    const text = flattenText(message.content)
    if (images.length === 0) {
      if (text.length > 0) items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
    } else {
      const parts = []
      if (text.length > 0) parts.push({ type: 'input_text', text })
      for (const image of images) {
        if (attachments === undefined)
          throw new LlmError('The Responses adapter received an image but no attachment service is mounted.', 'UNSUPPORTED_CONTENT')
        const stored = await attachments.readImage(image.attachment, signal)
        const url = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
        parts.push({ type: 'input_image', image_url: url, detail: 'high' })
      }
      items.push({ type: 'message', role: 'user', content: parts })
    }
    for (const result of toolResults) {
      const output = flattenText(result.content) || '(no output)'
      items.push(
        customCallIds.has(String(result.toolCallId))
          ? { type: 'custom_tool_call_output', call_id: String(result.toolCallId), output }
          : { type: 'function_call_output', call_id: String(result.toolCallId), output }
      )
    }
  }
  return { instructions: instructions.join('\n\n'), items }
}

/**
 * Map harness ToolSchemas to Responses-API tools: freeform names become
 * `custom` tools (apply_patch carries codex's grammar; other names degrade to
 * plain text format), everything else a `function` tool with `strict: false`
 * exactly like codex (codex-rs/tools/src/responses_api.rs:161).
 */
function wireTools(tools, freeformTools) {
  return (tools ?? []).map((tool) =>
    freeformTools.has(tool.name)
      ? {
          type: 'custom',
          name: tool.name,
          description: tool.name === 'apply_patch' ? APPLY_PATCH_DESCRIPTION : tool.description,
          format:
            tool.name === 'apply_patch'
              ? { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_LARK_GRAMMAR }
              : { type: 'text' },
        }
      : { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
  )
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
  const serialized = await serializeInput(options.messages, attachments, defaults.freeformTools, options.signal)
  const instructions = [options.system, serialized.instructions].filter((part) => part !== undefined && part.length > 0).join('\n\n')
  const tools = wireTools(options.tools, defaults.freeformTools)
  const effort = resolveEffort(options, defaults)
  return {
    model: options.model,
    ...(instructions.length > 0 ? { instructions } : {}),
    input: serialized.items,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

// ── SSE parsing (dependency-free) ──────────────────────────────────────────

/**
 * Parse an OpenAI SSE byte stream into data payloads. Yields until the stream
 * ends (the Responses API does not reliably send `[DONE]`; codex does not
 * depend on one either). A trailing partial `data:` line is still yielded.
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
        if (data.length > 0) yield data
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trimStart()
    if (data.length > 0) yield data
  }
}

// ── SSE translation ────────────────────────────────────────────────────────

/** One in-flight tool-call block keyed by the provider call id. */
function toolBlock(index, kind, callId, name) {
  return { index, kind, callId, name, raw: '' }
}

function closeToolBlock(block, freeformTools) {
  if (block.kind === 'custom') {
    return {
      type: 'tool-call',
      id: CallId(block.callId),
      name: block.name,
      arguments: JSON.stringify({ patch: block.raw }),
    }
  }
  return { type: 'tool-call', id: CallId(block.callId), name: block.name, arguments: block.raw }
}

/**
 * Consume Responses-API SSE payloads and yield harness StreamChunks. Text and
 * reasoning blocks open lazily on their first delta and close at
 * `output_item.done`; tool-call blocks open at `output_item.added`, accumulate
 * optional argument/input deltas, and finalize at `output_item.done` from the
 * item's complete payload (the codex-reliable path). `response.completed`
 * emits usage + a finish whose kind is `tool-calls` when any tool call was
 * produced, else `stop`. A stream ending without a terminal event throws.
 */
async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  let pendingUsage
  let sawCompleted = false
  let toolCallCount = 0
  const order = []
  const openBlock = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  function* yieldText(block, text) {
    if (!block.opened) {
      block.opened = true
      yield { type: 'block-start', index: block.index, blockType: 'text' }
    }
    block.text += text
    yield { type: 'text-delta', index: block.index, text }
  }
  function* yieldReasoning(block, text) {
    if (!block.opened) {
      block.opened = true
      yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
    }
    block.text += text
    yield { type: 'reasoning-delta', index: block.index, text }
  }
  function* closeText(block) {
    if (block !== undefined && block.opened) {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
    }
  }
  function* closeReasoning(block) {
    if (block !== undefined && block.opened) {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
    }
  }
  function* closeAll() {
    for (const block of toolBlocks.values()) {
      if (!block.finished) {
        block.finished = true
        yield { type: 'block-end', index: block.index, block: closeToolBlock(block) }
      }
    }
    yield* closeText(textBlock)
    yield* closeReasoning(reasoningBlock)
  }
  function* emitFinish(reason) {
    yield { type: 'finish', reason }
  }
  for await (const payload of payloads) {
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    switch (event.type) {
      case 'response.output_text.delta': {
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          if (!textBlock) textBlock = openBlock('text')
          yield* yieldText(textBlock, event.delta)
        }
        break
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          if (!reasoningBlock) reasoningBlock = openBlock('reasoning')
          yield* yieldReasoning(reasoningBlock, event.delta)
        }
        break
      }
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
          const key = item.call_id ?? item.id
          if (typeof key === 'string' && !toolBlocks.has(key)) {
            const block = toolBlock(nextIndex++, item.type === 'custom_tool_call' ? 'custom' : 'function', key, item.name)
            toolBlocks.set(key, block)
            order.push(block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const key = event.call_id ?? event.item_id
        const block = typeof key === 'string' ? toolBlocks.get(key) : undefined
        if (block !== undefined && typeof event.delta === 'string') block.raw += event.delta
        break
      }
      case 'response.custom_tool_call_input.delta': {
        const key = event.call_id ?? event.item_id
        const block = typeof key === 'string' ? toolBlocks.get(key) : undefined
        if (block !== undefined && typeof event.delta === 'string') block.raw += event.delta
        break
      }
      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
          const key = item.call_id ?? item.id
          // Some proxies omit `output_item.added`; open the block lazily at done.
          let block = typeof key === 'string' ? toolBlocks.get(key) : undefined
          if (block === undefined && typeof key === 'string') {
            block = toolBlock(nextIndex++, item.type === 'custom_tool_call' ? 'custom' : 'function', key, item.name)
            toolBlocks.set(key, block)
            order.push(block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (block !== undefined) {
            // Prefer the item's complete payload (the reliable path); fall back
            // to whatever deltas accumulated when the item omits it.
            if (item.type === 'custom_tool_call' && typeof item.input === 'string' && item.input.length > 0) {
              block.raw = item.input
            } else if (item.type === 'function_call' && typeof item.arguments === 'string' && item.arguments.length > 0) {
              block.raw = item.arguments
            }
            block.finished = true
            toolCallCount++
            yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId), name: block.name, argumentsDelta: block.raw }
            yield { type: 'block-end', index: block.index, block: closeToolBlock(block) }
          }
          break
        }
        if (item?.type === 'message') {
          yield* closeText(textBlock)
          textBlock = undefined
          break
        }
        if (item?.type === 'reasoning') {
          yield* closeReasoning(reasoningBlock)
          reasoningBlock = undefined
          break
        }
        break
      }
      case 'response.completed': {
        sawCompleted = true
        if (event.response?.usage) pendingUsage = mapUsage(event.response.usage)
        break
      }
      case 'response.incomplete': {
        sawCompleted = true
        yield* closeAll()
        if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
        yield* emitFinish({ kind: 'max-tokens' })
        return
      }
      case 'response.failed': {
        sawCompleted = true
        yield* closeAll()
        const error = event.response?.error
        yield* emitFinish({ kind: 'error', failure: failedFailure(error) })
        return
      }
      default:
        break
    }
  }
  if (!sawCompleted) throw new LlmError('SSE stream ended without a terminal event', 'STREAM_CLOSED')
  yield* closeAll()
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  const reason =
    toolCallCount > 0
      ? { kind: 'tool-calls' }
      : order.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
        : { kind: 'stop' }
  yield* emitFinish(reason)
}

/** Map a `response.failed` error payload to a harness failure. */
function failedFailure(error) {
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  let code = 'STREAM'
  if (isQuotaExceededError(detail)) code = QUOTA_EXCEEDED_CODE
  else if (isContextWindowExceededError(detail)) code = CONTEXT_WINDOW_EXCEEDED_CODE
  else if (error?.code === 'invalid_prompt' || error?.code === 'bio_policy') code = 'INVALID_REQUEST'
  else if (error?.code === 'server_overloaded' || error?.type === 'server_error') code = 'SERVER'
  return { message: error?.message ?? 'model response failed', code }
}

/** Map `response.completed` usage to the harness's disjoint token accounting. */
function mapUsage(usage) {
  const cached = usage.input_tokens_details?.cached_tokens
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.input_tokens - (cached ?? 0),
    outputTokens: usage.output_tokens,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

// ── error mapping (HTTP) ───────────────────────────────────────────────────

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
 * `ResponsesAdapter`: fetch + SSE against an OpenAI Responses endpoint,
 * emitting harness StreamChunks. Transport-only: connection facts arrive
 * through a thunk and the bearer token through a per-request resolver.
 */
class ResponsesAdapter extends LlmAdapter {
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
      response = await fetch(`${connection.baseURL}/responses`, {
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
      ctx.logger?.error('llm-responses: invalid configuration')
      ctx.logger?.error(error)
      throw error
    }
  }
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-responses', ref)
    }
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return assertUsableApiKey(ambient, 'llm-responses', ref)
    throw new LlmError(
      `llm-responses: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL'
    )
  }
  const adapter = new ResponsesAdapter({ options, resolveApiKey, attachments: () => ctx.get('attachments') })
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: [] }])
  ctx.llm.registerAdapter([PROVIDER], adapter)
}

export { ResponsesAdapter, PUBLIC_BASE_URL, APPLY_PATCH_DESCRIPTION, APPLY_PATCH_LARK_GRAMMAR }
