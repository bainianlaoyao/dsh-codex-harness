import assert from 'node:assert/strict'
import { apply as responses } from './llm-responses.js'
import { apply as chat } from './llm-openai.js'
process.env.CODEX_ALIGNMENT_TEST_KEY = 'fixture-only'
const originalFetch = globalThis.fetch
let body, events = []
globalThis.fetch = async (_url, init) => {
  body = JSON.parse(init.body)
  return { ok: true, body: (async function* () {
    for (const event of events) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    if (!events[0]?.type) yield new TextEncoder().encode('data: [DONE]\n\n')
  })() }
}
function adapter(install, config = {}) {
  let value
  install({ llm: { registerAdapter(_providers, result) { value = result }, registerConfigurableProviders() {} },
    get: name => name === 'attachments' ? { readImage: async () => ({ ref: { mediaType: 'image/png' }, data: Buffer.from('image-fixture') }) } : undefined },
  { apiKeyEnv: 'CODEX_ALIGNMENT_TEST_KEY', ...config })
  return value
}
const collect = async (value, options) => { const chunks = []; for await (const chunk of value.stream({ model: 'gpt-5.1-codex', messages: [], tools: [], ...options })) chunks.push(chunk); return chunks }
try {
  for (const install of [responses, chat]) {
    const value = adapter(install)
    events = install === responses ? [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]
      : [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]
    await collect(value, { messages: [
      { role: 'developer', content: [{ type: 'text', text: 'developer-policy' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'image', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'text', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'image-output' }, { type: 'image', attachment: {}, detail: 'low' }] },
      { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'text-output' }] },
    ] })
    const wire = body.input ?? body.messages
    assert.ok(wire.some(item => item.role === 'developer'))
    assert.match(JSON.stringify(wire), /data:image\/png;base64/)
    assert.match(JSON.stringify(wire), /image-output/)
    assert.match(JSON.stringify(wire), /text-output/)
    if (install === chat) assert.deepEqual(wire.map(item => item.role), ['developer', 'assistant', 'tool', 'tool', 'user'])
    assert.equal((await value.resolveModel('p', 'unknown')).reasoning, undefined)
    const custom = adapter(install, { models: [{ id: 'custom', reasoningEfforts: [], inputModalities: ['text'] }] })
    const info = await custom.resolveModel('custom-provider', 'custom')
    assert.equal(info.context, undefined)
    assert.deepEqual(info.inputModalities, ['text'])
    await collect(custom, { model: 'custom' })
    assert.equal(body.reasoning_effort ?? body.reasoning, undefined)
    await assert.rejects(() => collect(custom, { model: 'custom', reasoningEffort: 'high' }), /does not support/)
  }
  const value = adapter(responses)
  events = [
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r1', encrypted_content: 'opaque-state', summary: [] } },
    { type: 'response.output_item.done', item: { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'working' }] } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 't1', name: 'shell', arguments: '{}' } },
    { type: 'response.completed' },
  ]
  const chunks = await collect(value, {})
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  const message = { role: 'assistant', source: { replayState: finish.replayState }, content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) }
  events = [{ type: 'response.output_text.delta', delta: 'done' }, { type: 'response.completed' }]
  await collect(value, { messages: [message] })
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.deepEqual(body.input.map(item => item.type), ['reasoning', 'message', 'function_call'])
  assert.equal(body.input[1].phase, 'commentary')
  await collect(value, { model: 'different', messages: [message] })
  assert.ok(!JSON.stringify(body.input).includes('opaque-state'))
  const modified = structuredClone(message); modified.content[0].text = 'rewritten'
  await collect(value, { messages: [modified] })
  assert.ok(!JSON.stringify(body.input).includes('opaque-state'))
  const trimmed = structuredClone(message); trimmed.content.pop()
  await collect(value, { messages: [trimmed] })
  assert.ok(!body.input.some(item => item.type === 'function_call'))
  assert.ok(!JSON.stringify(body.input).includes('opaque-state'))
  events = [{ type: 'response.failed', response: { error: { code: 'server_is_overloaded', message: 'busy', headers: { 'Retry-After': '2' } } } }]
  const failed = (await collect(value, {})).find(chunk => chunk.type === 'finish')
  assert.equal(failed.reason.failure.code, 'SERVER')
  assert.equal(failed.reason.failure.providerRetryAfterMs, 2000)
  assert.equal(failed.replayState, undefined)
  console.log('Model alignment: direct tool batches/images, developer role, capabilities, ordered replay/phase, trim/route safety and retry PASS')
} finally { globalThis.fetch = originalFetch; delete process.env.CODEX_ALIGNMENT_TEST_KEY }
