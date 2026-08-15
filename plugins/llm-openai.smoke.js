/**
 * M0 smoke test for dsh-codex/llm-openai.js — runs OUTSIDE the harness with a
 * mock ctx.llm and a mock fetch, validating plugin assembly, wire
 * serialization, and SSE translation without network access.
 *
 * Usage: node dsh-codex/llm-openai.smoke.js   (run from the profile root so
 * bare imports resolve from the hoisted node_modules)
 */
import assert from 'node:assert/strict'

let registeredAdapter
let configurableProviders
const ctx = {
  llm: {
    registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['openai-official'])
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

const { apply } = await import('./llm-openai.js')
apply(ctx, {})

assert.ok(registeredAdapter, 'adapter registered')
assert.deepEqual(
  configurableProviders,
  [{ provider: 'openai-official', displayName: 'OpenAI', settingsNs: 'llm-openai', settingsPath: [] }],
  'configurable provider directory'
)

const info = await registeredAdapter.resolveModel('openai-official', 'gpt-5.5')
assert.equal(info.id, 'gpt-5.5')
assert.equal(info.context.contextWindow, 400000)
assert.ok(info.reasoning.efforts.length === 5, 'five reasoning efforts')
assert.equal(String(info.reasoning.defaultEffort), 'high')

// ── synthetic SSE round-trip ───────────────────────────────────────────────
process.env.OPENAI_API_KEY = 'sk-smoke-test-only'
const sse = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"command\\":"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"echo hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
  'data: [DONE]\n\n',
]
let capturedBody
let capturedUrl
globalThis.fetch = async (url, init) => {
  capturedUrl = url
  capturedBody = JSON.parse(init.body)
  return {
    ok: true,
    body: (async function* () {
      for (const chunk of sse) yield new TextEncoder().encode(chunk)
    })(),
  }
}

const chunks = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-official',
  model: 'gpt-5.5',
  system: 'You are a coding agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run a command' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_0', name: 'shell', arguments: '{"command":"ls"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_0', content: [{ type: 'text', text: 'file.txt' }] }] },
  ],
  tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
  reasoningEffort: 'medium',
  maxTokens: 4096,
})) {
  chunks.push(chunk)
}

assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions')
assert.equal(capturedBody.model, 'gpt-5.5')
assert.equal(capturedBody.stream, true)
assert.equal(capturedBody.reasoning_effort, 'medium')
assert.equal(capturedBody.max_completion_tokens, 4096)
assert.equal(capturedBody.messages.length, 4) // system + user + assistant + tool (tool-result merged, no stray user)
assert.equal(capturedBody.messages[0].role, 'system')
assert.equal(capturedBody.messages[3].role, 'tool')
assert.equal(capturedBody.messages[3].tool_call_id, 'call_0')
assert.equal(capturedBody.tools[0].type, 'function')

const kinds = chunks.map((chunk) => chunk.type)
assert.ok(kinds.includes('block-start') && kinds.includes('text-delta') && kinds.includes('reasoning-delta'))
assert.ok(kinds.includes('tool-call-delta') && kinds.includes('block-end') && kinds.includes('usage') && kinds.includes('finish'))
const usage = chunks.find((chunk) => chunk.type === 'usage').usage
assert.deepEqual(usage, { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 3 })
const finish = chunks.find((chunk) => chunk.type === 'finish').reason
assert.equal(finish.kind, 'tool-calls')
const toolBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
assert.equal(toolBlock.name, 'shell')
assert.deepEqual(JSON.parse(toolBlock.arguments), { command: 'echo hi' })
assert.equal(String(toolBlock.id), 'call_1')

// ── image content ──────────────────────────────────────────────────────────
let imageRequested = false
const realGet = ctx.get.bind(ctx)
ctx.get = (service) => {
  if (service === 'attachments')
    return {
      async readImage(ref) {
        imageRequested = true
        return { ref: { mediaType: 'image/png', bytes: 4, width: 1, height: 1 }, data: new Uint8Array([1, 2, 3, 4]) }
      },
    }
  return realGet(service)
}
const imageChunks = []
for await (const chunk of registeredAdapter.stream({
  provider: 'openai-official',
  model: 'gpt-5',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      ],
    },
  ],
})) {
  imageChunks.push(chunk)
}
assert.ok(imageRequested, 'image attachment resolved through the store')
assert.equal(capturedBody.messages[0].role, 'user')
assert.equal(capturedBody.messages[0].content[0].type, 'text')
assert.equal(capturedBody.messages[0].content[1].type, 'image_url')
assert.equal(capturedBody.messages[0].content[1].image_url.url, 'data:image/png;base64,AQIDBA==')
assert.equal(capturedBody.messages[0].content[1].image_url.detail, 'high')

console.log('llm-openai smoke test: ALL PASS')
