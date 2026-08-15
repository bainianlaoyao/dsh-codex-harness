/**
 * Smoke test for dsh-codex/llm-responses.js — runs OUTSIDE the harness with a
 * mock ctx.llm and a mock fetch, validating plugin assembly, Responses-API
 * wire serialization (freeform custom apply_patch + function tools), history
 * item round-trips, and SSE translation without network access.
 *
 * Usage: node dsh-codex/llm-responses.smoke.js   (run from the profile root so
 * bare imports resolve from the hoisted node_modules)
 */
import assert from 'node:assert/strict'

let registeredAdapter
let configurableProviders
const ctx = {
  llm: {
    registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['openai-responses'])
      registeredAdapter = adapter
      return () => {}
    },
    registerConfigurableProviders(entries) {
      configurableProviders = entries
      return () => {}
    },
  },
  get() {
    return undefined
  },
}

const { apply, APPLY_PATCH_DESCRIPTION, APPLY_PATCH_LARK_GRAMMAR } = await import('./llm-responses.js')
apply(ctx, {})

assert.ok(registeredAdapter, 'adapter registered')
assert.deepEqual(
  configurableProviders,
  [{ provider: 'openai-responses', displayName: 'OpenAI Responses', settingsNs: 'llm-responses', settingsPath: [] }],
  'configurable provider directory'
)

const info = await registeredAdapter.resolveModel('openai-responses', 'gpt-5.1-codex')
assert.equal(info.id, 'gpt-5.1-codex')
assert.equal(info.context.contextWindow, 400000)
assert.ok(info.reasoning.efforts.length === 5, 'five reasoning efforts')
assert.equal(String(info.reasoning.defaultEffort), 'high')

// ── request-body serialization (history + tools round-trip) ────────────────
process.env.OPENAI_API_KEY = 'sk-smoke-test-only'
const PATCH = '*** Begin Patch\n*** Add File: x.txt\n+one\n*** End Patch'
let capturedBody
let capturedUrl
globalThis.fetch = async (url, init) => {
  capturedUrl = url
  capturedBody = JSON.parse(init.body)
  return {
    ok: true,
    body: (async function* () {
      yield new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n')
    })(),
  }
}

const chunks = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-responses',
  model: 'gpt-5.1-codex',
  system: 'You are a coding agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool-call', id: 'call_a', name: 'shell', arguments: '{"cmd":"pwd"}' },
        { type: 'tool-call', id: 'call_b', name: 'apply_patch', arguments: JSON.stringify({ patch: PATCH }) },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: '/tmp' }] },
        { type: 'tool-result', toolCallId: 'call_b', content: [{ type: 'text', text: 'A x.txt' }] },
      ],
    },
  ],
  tools: [
    { name: 'apply_patch', description: 'FREEFORM', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] } },
    { name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  ],
  reasoningEffort: 'medium',
  maxTokens: 4096,
})) {
  chunks.push(chunk)
}

assert.equal(capturedUrl, 'https://api.openai.com/v1/responses')
assert.equal(capturedBody.model, 'gpt-5.1-codex')
assert.equal(capturedBody.stream, true)
assert.equal(capturedBody.store, false)
assert.equal(capturedBody.parallel_tool_calls, true)
assert.equal(capturedBody.instructions, 'You are a coding agent.')
assert.deepEqual(capturedBody.reasoning, { effort: 'medium' })
assert.equal(capturedBody.max_output_tokens, 4096)

// freeform apply_patch → custom tool with codex verbatim description + lark grammar
const apTool = capturedBody.tools.find((tool) => tool.name === 'apply_patch')
assert.equal(apTool.type, 'custom')
assert.equal(apTool.description, APPLY_PATCH_DESCRIPTION)
assert.equal(apTool.description, 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.')
assert.deepEqual(apTool.format, { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_LARK_GRAMMAR })
assert.ok(APPLY_PATCH_LARK_GRAMMAR.includes('begin_patch: "*** Begin Patch" LF'), 'grammar is the codex lark grammar')
// other tools → function with strict:false (codex parity)
const shellTool = capturedBody.tools.find((tool) => tool.name === 'shell')
assert.equal(shellTool.type, 'function')
assert.equal(shellTool.strict, false)
assert.deepEqual(shellTool.parameters.properties, { cmd: { type: 'string' } })

// input items
assert.deepEqual(capturedBody.input, [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
  { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"pwd"}' },
  { type: 'custom_tool_call', call_id: 'call_b', name: 'apply_patch', input: PATCH },
  { type: 'function_call_output', call_id: 'call_a', output: '/tmp' },
  { type: 'custom_tool_call_output', call_id: 'call_b', output: 'A x.txt' },
])

// finish of the empty completed response: EMPTY_RESPONSE error
const finish = chunks.find((chunk) => chunk.type === 'finish').reason
assert.equal(finish.kind, 'error')
assert.equal(finish.failure.code, 'EMPTY_RESPONSE')

// ── SSE translation: text + function call + freeform custom call ───────────
const sse = [
  { type: 'response.output_text.delta', delta: 'Hello' },
  { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'shell' } },
  { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"cmd":"ls"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' } },
  { type: 'response.output_item.added', item: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch' } },
  { type: 'response.custom_tool_call_input.delta', item_id: 'call_2', delta: '*** Begin Patch\n*** Add File: a.txt' },
  {
    type: 'response.output_item.done',
    item: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch' },
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 15,
      },
    },
  },
]
globalThis.fetch = async (url, init) => ({
  ok: true,
  body: (async function* () {
    for (const event of sse) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  })(),
})

const chunks2 = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-responses',
  model: 'gpt-5.1-codex',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  tools: [{ name: 'apply_patch', description: 'FREEFORM', parameters: { type: 'object', properties: {} } }],
})) {
  chunks2.push(chunk)
}

const kinds = chunks2.map((chunk) => chunk.type)
assert.ok(kinds.includes('block-start'), 'block-start emitted')
assert.ok(kinds.includes('text-delta') && kinds.includes('reasoning-delta') === false, 'text delta present, no reasoning')
assert.equal(kinds.filter((kind) => kind === 'tool-call-delta').length, 2, 'two tool-call deltas')
assert.equal(kinds.filter((kind) => kind === 'block-end').length, 3, 'text + two tool blocks closed')

const ends = chunks2.filter((chunk) => chunk.type === 'block-end')
const textEnd = ends.find((chunk) => chunk.block.type === 'text')
assert.equal(textEnd.block.text, 'Hello')
const fnEnd = ends.find((chunk) => chunk.block.type === 'tool-call' && String(chunk.block.id) === 'call_1')
assert.equal(fnEnd.block.name, 'shell')
assert.deepEqual(JSON.parse(fnEnd.block.arguments), { cmd: 'ls' })
const customEnd = ends.find((chunk) => chunk.block.type === 'tool-call' && String(chunk.block.id) === 'call_2')
assert.equal(customEnd.block.name, 'apply_patch')
// the model's raw freeform patch arrives as harness JSON args; the raw text is intact
assert.deepEqual(JSON.parse(customEnd.block.arguments), {
  patch: '*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch',
})

const usage = chunks2.find((chunk) => chunk.type === 'usage').usage
assert.deepEqual(usage, { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 3 })
const finish2 = chunks2.find((chunk) => chunk.type === 'finish').reason
assert.equal(finish2.kind, 'tool-calls', 'tool calls present → tool-calls finish')

// ── text-only response → stop finish ───────────────────────────────────────
globalThis.fetch = async () => ({
  ok: true,
  body: (async function* () {
    yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"done"}\n\n')
    yield new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
  })(),
})
const chunks3 = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-responses',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
})) {
  chunks3.push(chunk)
}
assert.equal(chunks3.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')

// ── response.failed → error finish ─────────────────────────────────────────
globalThis.fetch = async () => ({
  ok: true,
  body: (async function* () {
    yield new TextEncoder().encode(
      'data: {"type":"response.failed","response":{"id":"r","error":{"code":"invalid_prompt","message":"bad prompt"}}}\n\n'
    )
  })(),
})
const chunks4 = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-responses',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
})) {
  chunks4.push(chunk)
}
const failed = chunks4.find((chunk) => chunk.type === 'finish').reason
assert.equal(failed.kind, 'error')
assert.equal(failed.failure.code, 'INVALID_REQUEST')

// ── response.incomplete → max-tokens finish ────────────────────────────────
globalThis.fetch = async () => ({
  ok: true,
  body: (async function* () {
    yield new TextEncoder().encode(
      'data: {"type":"response.incomplete","response":{"id":"r","incomplete_details":{"reason":"max_output_tokens"}}}\n\n'
    )
  })(),
})
const chunks5 = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-responses',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
})) {
  chunks5.push(chunk)
}
assert.equal(chunks5.find((chunk) => chunk.type === 'finish').reason.kind, 'max-tokens')

// ── truncated stream → STREAM_CLOSED ───────────────────────────────────────
globalThis.fetch = async () => ({
  ok: true,
  body: (async function* () {
    yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
  })(),
})
await assert.rejects(
  (async () => {
    for await (const _ of registeredAdapter.stream({
      provider: 'openai-responses',
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
    }
  })(),
  (error) => error.code === 'STREAM_CLOSED'
)

console.log('llm-responses smoke test: ALL PASS')
