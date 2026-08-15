/**
 * M1 smoke test for dsh-codex/tools/request-user-input.js — mock
 * `ctx.userQuestions.ask` capturing the mapped request and returning a canned
 * answer, verifying the codex response shape, the required question fields, the
 * non-empty-options validation, and the cancelled seam.
 *
 * Usage: node dsh-codex/tools/request-user-input.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
let lastAsk = null
let canned = { answers: [{ id: 'mode', selected: ['Fast (Recommended)'], custom: '' }] }

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  userQuestions: {
    async ask(request) {
      lastAsk = request
      return canned
    },
  },
}

const { apply } = await import('./request-user-input.js')
apply(ctx, {})

const tool = captured.find((t) => t.name === 'request_user_input')
assert.ok(tool, 'request_user_input registered')

const makeExec = () => ({
  agent: { session: { header: { cwd: 'C:/tmp' }, append() {} }, ctx: { effect: () => () => {} } },
  signal: new AbortController().signal,
  callId: 'call-1',
})
const run = (args, exec = makeExec()) => tool.execute(args, exec)

const questions = [
  {
    id: 'mode',
    header: 'Mode',
    question: 'How should I proceed?',
    options: [
      { label: 'Fast (Recommended)', description: 'Quick but less thorough.' },
      { label: 'Careful', description: 'Slower but verified.' },
    ],
  },
]

// ── happy path: ask() mapping + codex response shape ───────────────────────
const exec = makeExec()
const value = await run({ questions }, exec)
assert.ok(lastAsk, 'ask called')
assert.deepEqual(
  lastAsk.questions,
  [{ id: 'mode', question: 'How should I proceed?', header: 'Mode', options: questions[0].options }],
  'questions mapped for the DSH seam'
)
assert.equal(lastAsk.agent, exec.agent, 'agent forwarded')
assert.ok(lastAsk.signal instanceof AbortSignal, 'signal forwarded')
assert.deepEqual(value, { answers: { mode: { answers: ['Fast (Recommended)'] } } }, 'answers mapped to codex {answers:{id:{answers:[...]}}} shape')

// ── custom free-form text is appended after selected ───────────────────────
canned = { answers: [{ id: 'mode', selected: [], custom: 'Something else' }] }
const withCustom = await run({ questions })
assert.deepEqual(withCustom, { answers: { mode: { answers: ['Something else'] } } }, 'custom appended into answers array')

// ── render ─────────────────────────────────────────────────────────────────
canned = { answers: [{ id: 'mode', selected: ['Fast (Recommended)'], custom: '' }] }
const happy = await run({ questions })
const text = tool.output.render({ questions }, happy)[0].text
assert.equal(text, JSON.stringify(happy), 'render is JSON.stringify of answers')
const present = tool.presentCall({ questions })
assert.equal(present.title, 'Request user input', 'presentCall title')

// ── non-empty options is codex's only question validation ──────────────────
await assert.rejects(
  () => run({ questions: [{ id: 'none', header: 'H', question: 'Q?', options: [] }] }),
  /request_user_input requires non-empty options for every question/,
  'empty options rejected'
)

// ── no 1-3 count / snake_case / header-length / options-count limits ───────
const opts = (n) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, description: `d${i}` }))
await run({
  questions: [
    { id: 'Not-Snake!', header: 'This header is way too long', question: 'Q1?', options: opts(1) },
    { id: 'b', header: 'B', question: 'Q2?', options: opts(2) },
    { id: 'c', header: 'C', question: 'Q3?', options: opts(3) },
    { id: 'd', header: 'D', question: 'Q4?', options: opts(4) },
  ],
})

// ── cancelled seam surfaces the codex message ──────────────────────────────
canned = null
await assert.rejects(
  () => run({ questions }),
  /request_user_input was cancelled before receiving a response/,
  'cancelled seam surfaced'
)
canned = { answers: [{ id: 'mode', selected: ['Fast (Recommended)'], custom: '' }] }

// ── schema spot checks (codex-parity wording) ──────────────────────────────
const qSchema = tool.parameters.properties.questions
assert.ok(tool.parameters.required.includes('questions'), 'questions required')
assert.equal(qSchema.description, 'Questions to show the user. Prefer 1 and do not exceed 3', 'codex questions description')
assert.deepEqual(qSchema.items.required, ['id', 'header', 'question', 'options'], 'id+header+question+options required')
assert.equal(
  qSchema.items.properties.options.description,
  'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
  'codex options description'
)

console.log('request-user-input smoke test: ALL PASS')
