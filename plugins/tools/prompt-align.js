/**
 * dsh-codex — prompt-surface alignment (context audit fixes, 2026-08-15).
 *
 * Two jobs, both through the scoped system-prompt registry:
 *
 * 1. Shadow the DSH platform sections that leak into codex sessions. The
 *    host composition registers these GLOBALLY; a scoped section with the
 *    same name replaces the global one, and an empty text is dropped at
 *    render (dsh-system-prompt renderPrompt filters empty sections):
 *      - app:web-surface (dsh-web-app): checkout / Web-GUI operational prose
 *        (dev server, HMR, build notes) — noise for a coding agent.
 *      - tool:bash (dsh-tool-bash): "Check the [exit code: N] marker on
 *        every bash result" — MISLEADING here: codex mode has no `bash` tool
 *        (tool-codex-restrict denies it) and exec_command returns its own
 *        "Process exited with code N" markers.
 *      - tool:web_search / tool:web_fetch (dsh-tool-web): usage prose already
 *        carried by the tool schemas.
 *      - ui:deliverable-file-references (dsh-client-ui-deliverables): DSH
 *        file-tool path conventions; the codex persona carries its own
 *        complete "File References" section.
 *    harness:identity ("You are an AI agent powered by DeepSeek Harness.")
 *    is KEPT: one true sentence about the platform.
 *
 * 2. Add the codex world-state fragments as runtime-context sections. The
 *    dsh-system-prompt context registry feeds the "Current runtime context"
 *    snapshot, which dsh-agent-loop diff-injects (only re-sent when the
 *    joined text changes):
 *      - codex:environment — the <environment_context> fragment
 *        (codex-rs/core/src/context/world_state/environment.rs:203-260 +
 *        environment_context.rs), legacy-single shape: cwd / shell /
 *        current_date / timezone + filesystem permission profile. Network is
 *        omitted: DSH has no domain-allowlist model (codex omits it the same
 *        way when no network config exists).
 *      - codex:current-time — the <current_time_reminder> fragment
 *        (codex-rs/core/src/context/current_time_reminder.rs:31-37), body
 *        "It is {YYYY-MM-DD HH:MM:SS UTC}." codex injects it rate-limited
 *        (reminder_interval_seconds=1); the snapshot diff reinjects whenever
 *        the text changes, so the second-level timestamp gives the same
 *        per-turn freshness.
 *      - codex:sandbox-escalation — the per-session escalation status of the
 *        exec_command sandbox vocabulary (2026-08-16 dsh adaptation). codex's
 *        sandbox is an OS isolation layer dsh does not replicate, so the
 *        model-facing sandbox_permissions/justification/prefix_rule fields are
 *        meaningful only under a restricted host sandbox with an askable
 *        approval policy. The section tells the model whether the fields are
 *        LIVE (use require_escalated + justification) or INERT (omit them) —
 *        the model-side half of the adaptation, mirroring how DSH's own
 *        approval `never` mode instructs models not to request escalation.
 *
 * @module dsh-codex/tools/prompt-align
 */

export const name = 'tool-codex-prompt-align'
export const inject = ['systemPrompt']

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** "%Y-%m-%d %H:%M:%S UTC" (chrono Utc::format, current_time_reminder.rs:16-22). */
export function isoUtcSeconds(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} UTC`
}

/** Minimal XML escaping for values inside <cwd>/<shell>/<timezone> elements. */
export function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The <environment_context> fragment, legacy-single shape
 * (environment.rs:203-260; one environment, no <environments> wrapper).
 * Network is omitted (no DSH domain model). The filesystem permission
 * profile mirrors codex shapes from the DSH sandbox mode:
 *   danger-full-access / unknown → PermissionProfile::Disabled
 *                                 → <permission_profile type="disabled">
 *                                     <file_system type="unrestricted" />
 *                                   </permission_profile>
 *   workspace-write / read-only  → managed restricted (DSH has no
 *                                   sandbox-entry model; the sandbox:policy
 *                                   snapshot section carries the exact DSH
 *                                   wording).
 */
export function renderEnvironment(context, fs) {
  const cwd = context?.agent?.session?.header?.cwd
  const sandboxMode = fs?.sandboxMode
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return 'UTC'
    }
  })()
  const now = new Date()
  const lines = []
  lines.push('<environment_context>')
  if (typeof cwd === 'string' && cwd.length > 0) lines.push(`  <cwd>${escapeXml(cwd)}</cwd>`)
  lines.push('  <shell>bash</shell>')
  lines.push(`  <current_date>${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}</current_date>`)
  lines.push(`  <timezone>${escapeXml(timezone)}</timezone>`)
  if (sandboxMode === undefined || sandboxMode === 'danger-full-access') {
    lines.push('  <permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>')
  } else {
    lines.push('  <permission_profile type="managed"><file_system type="restricted" /></permission_profile>')
  }
  lines.push('</environment_context>')
  return lines.join('\n')
}

/** The <current_time_reminder> fragment (current_time_reminder.rs:31-37). */
export function renderCurrentTime(date = new Date()) {
  return `<current_time_reminder>It is ${isoUtcSeconds(date)}.</current_time_reminder>`
}

/**
 * Per-session exec_command escalation status (2026-08-16 dsh adaptation).
 * codex's sandbox concept is an OS isolation layer dsh does not replicate;
 * the escalation vocabulary is therefore LIVE only when the DSH host sandbox
 * is restricted AND the approval policy can prompt. Everywhere else the fields
 * are inert — the model is told to omit them, mirroring how DSH's approval
 * `never` mode already instructs models not to request sandbox escalation.
 */
export function renderEscalationStatus(context, approval, fs) {
  const sandboxMode = fs?.sandboxMode
  const sessionPolicy = approval?.overrideOf?.(context?.agent?.session) ?? approval?.config?.policy
  const restricted = sandboxMode !== undefined && sandboxMode !== 'danger-full-access'
  if (!restricted || sessionPolicy === 'never') {
    return (
      'Codex sandbox escalation is INERT in this session: exec_command runs with full access and approvals are disabled. ' +
      'Do not set `sandbox_permissions` or `justification` on exec_command; omit them (or use `sandbox_permissions: "use_default"`).'
    )
  }
  return (
    `Codex sandbox escalation is LIVE: exec_command runs under a restricted sandbox (mode: ${sandboxMode}). ` +
    'To run a command needing wider access, set `sandbox_permissions: "require_escalated"` with a `justification`; the user will be asked to approve the escalation.'
  )
}

export function apply(ctx, _config) {
  // ── shadow DSH platform sections to empty (dropped at render) ────────────
  ctx.systemPrompt.section({ name: 'app:web-surface', order: -98, text: '' })
  ctx.systemPrompt.section({ name: 'tool:bash', order: 105, text: '' })
  ctx.systemPrompt.section({ name: 'tool:web_search', order: 110, text: '' })
  ctx.systemPrompt.section({ name: 'tool:web_fetch', order: 111, text: '' })
  ctx.systemPrompt.section({ name: 'ui:deliverable-file-references', order: 190, text: '' })

  // ── codex world-state fragments (runtime-context snapshot) ────────────────
  // Orders sit after the permissions sentences (sandbox:policy=110,
  // approval:policy=115) to match codex's permissions → environments order.
  ctx.systemPrompt.context({
    name: 'codex:sandbox-escalation',
    order: 116,
    text: (context) => renderEscalationStatus(context, ctx.get('approval'), ctx.get('fs')),
  })
  ctx.systemPrompt.context({
    name: 'codex:environment',
    order: 118,
    text: (context) => renderEnvironment(context, ctx.get('fs')),
  })
  ctx.systemPrompt.context({
    name: 'codex:current-time',
    order: 120,
    text: () => renderCurrentTime(),
  })
}
