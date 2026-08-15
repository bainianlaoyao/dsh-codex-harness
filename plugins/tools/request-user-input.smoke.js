/**
 * M1 smoke test for dsh-codex/tools/request-user-input.js — mock
 * `ctx.userQuestions.ask` capturing the mapped request and returning a canned
 * answer, verifying validation (1-3 questions), the DSH ask() mapping, and the
 * JSON render.
 *
 * Usage: node dsh-codex/tools/request-user-input.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const captured = []
let lastAsk = null
const mockAnswer = { answers: [{ id: 'mode', selected: ['Fast (Recommended)'], custom: '' }] }

const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  userQuestions: {
    async ask(request) {
      lastAsk = request
      return mockAnswer
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

// ── happy path: ask() mapping + answers passthrough ────────────────────────
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
assert.deepEqual(value, mockAnswer, 'answers returned as-is')

// ── header/options omitted stay omitted ────────────────────────────────────
await run({ questions: [{ id: 'plain', question: 'Just yes or no?' }] })
assert.deepEqual(lastAsk.questions, [{ id: 'plain', question: 'Just yes or no?' }], 'optional fields omitted')

// ── render ─────────────────────────────────────────────────────────────────
const text = tool.output.render({ questions }, value)[0].text
assert.equal(text, JSON.stringify(value), 'render is JSON.stringify of answers')
const present = tool.presentCall({ questions })
assert.equal(present.title, 'Request user input', 'presentCall title')

// ── validation ─────────────────────────────────────────────────────────────
const q = (id, extra = {}) => ({
  id,
  question: `Question ${id}?`,
  options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
  ...extra,
})
await assert.rejects(
  () => run({ questions: [q('a'), q('b'), q('c'), q('d')] }),
  /at most 3 questions \(got 4\)/,
  'more than 3 questions rejected'
)
await assert.rejects(() => run({ questions: [] }), /must contain 1-3 questions/, 'empty questions rejected')
await assert.rejects(
  () => run({ questions: [{ ...q('bad-id'), id: 'Not-Snake' }] }),
  /id must be a snake_case string/,
  'snake_case id enforced'
)
await assert.rejects(
  () => run({ questions: [{ ...q('long'), header: 'This header is way too long' }] }),
  /header must be 12 or fewer chars/,
  'header length enforced'
)
await assert.rejects(
  () => run({ questions: [{ ...q('one_opt'), options: [{ label: 'Only', description: 'one' }] }] }),
  /options must be 2-3 choices/,
  'options count enforced'
)

// ── schema spot checks (codex-parity wording) ──────────────────────────────
const qSchema = tool.parameters.properties.questions
assert.ok(tool.parameters.required.includes('questions'), 'questions required')
assert.equal(qSchema.description, 'Questions to show the user. Prefer 1 and do not exceed 3', 'codex questions description')
assert.deepEqual(qSchema.items.required, ['id', 'question'], 'id+question required, header/options optional')
assert.equal(
  qSchema.items.properties.options.description,
  'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
  'codex options description'
)

console.log('request-user-input smoke test: ALL PASS')
