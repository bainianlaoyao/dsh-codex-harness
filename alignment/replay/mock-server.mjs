/**
 * dsh-codex — trajectory mock model server (part 3).
 *
 * A minimal OpenAI Responses-API server (POST /v1/responses, SSE) that
 * serves a SCRIPTED trajectory: every request consumes the next step, so
 * the model output is fully mocked while every tool call executes against
 * the REAL harness (codex CLI or the DSH headless-codex profile).
 *
 * Step shape (trajectories.mjs):
 *   { text?: string, toolCalls?: [{ type: "function"|"custom", name, arguments? }], error?: string }
 * The final step must be plain text (no tool calls) so the turn ends.
 *
 * The server also logs every request body to $LOG (JSONL) — the full
 * model-visible prompt each harness assembled — and every response it
 * served. GET /v1/models returns a one-model catalog.
 *
 * Usage: node mock-server.mjs  (env: PORT, STEPS=JSON, LOG=path)
 *
 * @module dsh-codex/alignment/replay/mock-server
 */

import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 18923)
const steps = JSON.parse(process.env.STEPS || "[]")
const logPath = process.env.LOG || null

let stepIndex = 0
let responseSeq = 0
let lastSessionId = null

/**
 * Extract the session id from the previous request's tool outputs (the
 * harness feeds exec_command results back as function_call_output items
 * containing "Process running with session ID N"). Steps may reference it as
 * the literal placeholder $SESSION_ID in tool-call arguments.
 */
function captureSessionId(parsed) {
  if (!parsed || !Array.isArray(parsed.input)) return
  for (const item of parsed.input) {
    if (item?.type === 'function_call_output' && typeof item.output === 'string') {
      const match = item.output.match(/Process running with session ID (\d+)/)
      if (match) lastSessionId = Number(match[1])
    }
  }
}

/** Substitute runtime placeholders in one step's tool-call arguments. */
function renderArguments(argumentsText) {
  if (typeof argumentsText !== 'string') return argumentsText
  if (lastSessionId === null || !argumentsText.includes('$SESSION_ID')) return argumentsText
  // session_id is a NUMBER on the wire; replace the quoted placeholder with
  // the bare integer (the JSON-encoded args carry "session_id":"$SESSION_ID").
  return argumentsText.replace(/"\$SESSION_ID"/g, String(lastSessionId))
}

function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`
}

function logRequest(url, body, stepIndex) {
  if (!logPath) return
  fs.appendFileSync(logPath, JSON.stringify({ step: stepIndex, url, body }) + '\n')
}

function buildItems(step) {
  const items = []
  if (step.toolCalls) {
    for (const tc of step.toolCalls) {
      const isCustom = tc.type === 'custom'
      responseSeq++
      const item = {
        id: `call_${responseSeq}`,
        type: isCustom ? 'custom_tool_call' : 'function_call',
        status: 'completed',
        call_id: `call_${responseSeq}`,
        name: tc.name,
        [isCustom ? "input" : "arguments"]: renderArguments(tc.arguments ?? "{}"),
      }
      items.push(item)
    }
  }
  if (step.text !== undefined && step.text !== '') {
    responseSeq++
    items.push({ id: `msg_${responseSeq}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: step.text, annotations: [] }] })
  }
  return items
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5-codex', object: 'model', owned_by: 'mock' }] }))
      return
    }
    captureSessionId(parsed)
    const step = steps[Math.min(stepIndex, steps.length - 1)]
    stepIndex++
    logRequest(req.url, parsed, stepIndex - 1)
    if (!step) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock: no more steps' } }))
      return
    }
    if (step.error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: step.error, type: "invalid_request_error", code: step.errorCode } }))
      return
    }
    const items = buildItems(step)
    const resp = {
      id: `resp_${responseSeq}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'gpt-5-codex',
      output: items,
      output_text: items.filter((i) => i.type === 'message').map((i) => i.content[0].text).join(''),
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1100 },
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'mock-req-1' })
    res.write(sseEvent('response.created', { response: { id: resp.id, object: 'response', status: 'in_progress', model: resp.model } }))
    for (const item of items) {
      res.write(sseEvent('response.output_item.added', { output_index: 0, item }))
      if (item.type === 'message') {
        const text = item.content[0].text
        res.write(sseEvent('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }))
        for (let i = 0; i < text.length; i += 8) {
          res.write(sseEvent('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text.slice(i, i + 8) }))
        }
        res.write(sseEvent('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text }))
        res.write(sseEvent('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }))
      }
      res.write(sseEvent('response.output_item.done', { output_index: 0, item }))
    }
    res.write(sseEvent('response.completed', { response: resp }))
    res.end()
  })
})

server.listen(PORT, () => console.log('mock listening on ' + PORT))
process.on('SIGTERM', () => { if (logPath) fs.writeFileSync(logPath + '.done', '1'); process.exit(0) })
