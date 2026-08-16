/**
 * Smoke test for dsh-codex/tools/prompt-align.js — mocks `ctx.systemPrompt`
 * (section/context registry) and asserts: the DSH platform sections are
 * shadowed to empty text, the codex world-state fragments register with the
 * expected orders, and the rendered fragments match the codex byte shapes
 * (<environment_context> legacy-single, <current_time_reminder>).
 *
 * Usage: node dsh-codex/tools/prompt-align.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const sections = []
const contexts = []
let sandboxMode = 'danger-full-access'
let approvalPolicy = 'ask'
const ctx = {
  get(service) {
    if (service === 'fs') return { sandboxMode }
    if (service === 'approval') return { config: { policy: approvalPolicy }, overrideOf: () => undefined }
    return undefined
  },
  systemPrompt: {
    section(entry) {
      sections.push(entry)
    },
    context(entry) {
      contexts.push(entry)
    },
  },
}

const { apply, renderCurrentTime, renderEnvironment, renderEscalationStatus, isoUtcSeconds } = await import('./prompt-align.js')

apply(ctx, {})

// ── DSH platform sections shadowed to empty ────────────────────────────────
const names = sections.map((s) => s.name).sort()
assert.deepEqual(names, ['app:web-surface', 'tool:bash', 'tool:web_fetch', 'tool:web_search', 'ui:deliverable-file-references'], 'all five DSH platform sections shadowed')
for (const s of sections) assert.equal(s.text, '', `shadowed section ${s.name} carries empty text`)

// ── codex world-state fragments registered ─────────────────────────────────
assert.deepEqual(
  contexts.map((c) => c.name).sort(),
  ['codex:current-time', 'codex:environment', 'codex:sandbox-escalation'],
  'all three codex fragments registered'
)
const env = contexts.find((c) => c.name === 'codex:environment')
const time = contexts.find((c) => c.name === 'codex:current-time')
const escalation = contexts.find((c) => c.name === 'codex:sandbox-escalation')
assert.ok(env.order > 115, `environment after permissions sentences (order ${env.order})`)
assert.ok(time.order > env.order, 'current-time after environment')
assert.ok(escalation.order < env.order, 'sandbox-escalation before environment (after approval:policy=115)')

// ── environment fragment shape (danger-full-access → unrestricted) ─────────
const agent = { session: { header: { cwd: 'D:\\Data\\DEV\\dsh' } } }
const rendered = renderEnvironment({ agent }, ctx.get('fs'))
assert.ok(rendered.startsWith('<environment_context>\n'), 'opens with environment_context marker')
assert.ok(rendered.endsWith('</environment_context>'), 'closes with environment_context marker')
assert.ok(rendered.includes('  <cwd>D:\\Data\\DEV\\dsh</cwd>\n'), 'cwd element present')
assert.ok(rendered.includes('  <shell>bash</shell>\n'), 'shell element present')
assert.ok(/  <current_date>\d{4}-\d{2}-\d{2}<\/current_date>\n/.test(rendered), 'current_date element present')
assert.ok(rendered.includes('  <timezone>'), 'timezone element present')
assert.ok(rendered.includes('  <permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'), 'danger-full-access renders codex Disabled shape')

// ── environment fragment under a restricted sandbox ─────────────────────────
const restricted = renderEnvironment({ agent }, { sandboxMode: 'workspace-write' })
assert.ok(restricted.includes('  <permission_profile type="managed"><file_system type="restricted" /></permission_profile>'), 'restricted sandbox renders managed/restricted shape')

// ── current-time fragment shape (codex current_time_reminder.rs) ───────────
const fixed = new Date(Date.UTC(2026, 7, 15, 12, 45, 30))
assert.equal(isoUtcSeconds(fixed), '2026-08-15 12:45:30 UTC', 'UTC format matches chrono "%Y-%m-%d %H:%M:%S UTC"')
assert.equal(renderCurrentTime(fixed), '<current_time_reminder>It is 2026-08-15 12:45:30 UTC.</current_time_reminder>', 'current-time marker wrapping matches codex render() (no newlines)')

// ── XML escaping ───────────────────────────────────────────────────────────
assert.ok(renderEnvironment({ agent: { session: { header: { cwd: 'a&b<c>' } } } }, ctx.get('fs')).includes('  <cwd>a&amp;b&lt;c&gt;</cwd>'), 'cwd XML-escaped')

// ── per-session escalation status (2026-08-16 adaptation) ──────────────────
const escCtx = { agent }
const inertFullAccess = renderEscalationStatus(escCtx, ctx.get('approval'), ctx.get('fs'))
assert.ok(inertFullAccess.includes('INERT') && inertFullAccess.includes('Do not set `sandbox_permissions`'), 'full access + ask → escalation INERT')
approvalPolicy = 'never'
sandboxMode = 'workspace-write'
const inertNever = renderEscalationStatus(escCtx, ctx.get('approval'), ctx.get('fs'))
assert.ok(inertNever.includes('INERT'), 'restricted + never → escalation INERT (no prompts at all)')
approvalPolicy = 'ask'
const live = renderEscalationStatus(escCtx, ctx.get('approval'), ctx.get('fs'))
assert.ok(live.includes('LIVE') && live.includes('mode: workspace-write') && live.includes('require_escalated'), 'restricted + ask → escalation LIVE')
approvalPolicy = 'ask'
sandboxMode = 'danger-full-access'

console.log('prompt-align smoke test: ALL PASS')
