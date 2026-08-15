/**
 * Alignment test: DSH registered tool schemas vs codex official HEAD (5bc8da6d78).
 *
 * Loads fixtures/tool-schema.full.json (official, descriptions VERBATIM) and
 * asserts every registered DSH tool matches the official model-facing shape:
 *   - tool description (string equality)
 *   - parameter property-name set (extra / missing reported)
 *   - each property type / enum / items / nested schema
 *   - the required array (order-insensitive) at every object level
 *   - the additionalProperties flag
 *
 * DOC (documented differences): every intentional divergence is declared
 * below and EXCLUDED from the failure set, but still reported with expected
 * vs got. The official multi_agent_v1 tools are served under a NAMESPACE
 * ("multi_agent_v1", description "Tools for spawning and managing
 * sub-agents."); DSH registers them FLAT (un-namespaced), so this test
 * compares per-tool content only and documents the namespace difference.
 *
 * Usage: node alignment/tool-schema.alignment.smoke.js
 *        (from the profile root: dsh-codex-mode/plugins)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tool-schema.full.json', import.meta.url), 'utf8'))

// register every tool from our sources with minimal mock ctx seams
const captured = []
const ctx = {
  tools: { register: (definition) => captured.push(definition) },
  // update-plan.js injects the plan session projection (unused by schema comparison).
  inject: (_deps, callback) => callback({ sessionProjections: { register: () => () => {} } }),
}

await import('../tools/exec-command.js').then((m) => m.apply(ctx, {}))
await import('../tools/apply-patch.js').then((m) => m.apply(ctx, {}))
await import('../tools/update-plan.js').then((m) => m.apply(ctx, {}))
await import('../tools/view-image.js').then((m) => m.apply(ctx, {}))
await import('../tools/request-user-input.js').then((m) => m.apply(ctx, {}))
await import('../tools/multi-agent.js').then((m) => m.apply(ctx, { provider: 'spawn' }))

const byName = Object.fromEntries(captured.map((t) => [t.name, t]))

// documented differences (exempt from failure, still reported). A rule
// matches a mismatch when its tool (if set) matches and the mismatch path
// equals rule.path or sits under it (rule.path + ".").
const DOCUMENTED = [
  // DSH defineTool emits an OPEN parameter object (no additionalProperties
  // key); codex serves additionalProperties: false on every parameters root.
  { path: 'parameters.additionalProperties', reason: 'DSH defineTool emits an open parameter root (no additionalProperties key); codex serves additionalProperties: false' },

  // exec_command: our handler ALWAYS registers login; the official default
  // handler (allow_login_shell=false) has no login param.
  { tool: 'exec_command', path: 'parameters.properties.login', reason: 'DSH always registers login; official default (allow_login_shell=false) serves no login param' },

  // multi_agent_v1: DSH re-implements the five tools FLAT over ctx.subagents
  // with DSH-authored descriptions/fields rather than a verbatim schema port.
  { tool: 'spawn_agent', path: 'description', reason: 'DSH-authored description; official spawn_agent description is config-dependent guidance text' },
  { tool: 'spawn_agent', path: 'parameters.properties.agent_type.description', reason: 'DSH-authored property description (official is config-dependent)' },
  { tool: 'spawn_agent', path: 'parameters.properties.model.description', reason: 'DSH-authored property description' },
  { tool: 'spawn_agent', path: 'parameters.properties.service_tier.description', reason: 'DSH-authored property description' },
  { tool: 'spawn_agent', path: 'parameters.properties.reasoning_effort.description', reason: 'DSH-authored property description' },

  { tool: 'send_input', path: 'description', reason: 'DSH-authored description' },
  { tool: 'send_input', path: 'parameters.properties.target.description', reason: 'DSH-authored property description' },
  { tool: 'send_input', path: 'parameters.properties.interrupt.description', reason: 'DSH-authored property description' },

  { tool: 'resume_agent', path: 'description', reason: 'DSH-authored description' },
  { tool: 'resume_agent', path: 'parameters.properties.id.description', reason: 'DSH-authored property description' },

  { tool: 'wait_agent', path: 'description', reason: 'DSH-authored description' },
  { tool: 'wait_agent', path: 'parameters.properties.task_ids', reason: 'DSH-only accepted-for-parity field (extra field; official wait_agent has no task_ids)' },

  { tool: 'close_agent', path: 'description', reason: 'DSH-authored description' },
  { tool: 'close_agent', path: 'parameters.properties.target.description', reason: 'DSH-authored property description' },
]

function isExempt(mismatch) {
  for (const rule of DOCUMENTED) {
    if (rule.tool !== undefined && rule.tool !== mismatch.tool) continue
    if (mismatch.path === rule.path || mismatch.path.startsWith(rule.path + '.')) return rule.reason
  }
  return null
}

// recursive schema diff
function diffNode(expected, got, path, out) {
  if (expected === undefined || expected === null || typeof expected !== 'object') return
  if (Array.isArray(expected)) return
  if (Object.hasOwn(expected, 'type') && expected.type !== got?.type) {
    out.push({ path: path + '.type', expected: expected.type, got: got?.type })
  }
  if (Object.hasOwn(expected, 'description') && expected.description !== got?.description) {
    out.push({ path: path + '.description', expected: expected.description, got: got?.description })
  }
  if (Object.hasOwn(expected, 'enum') && JSON.stringify(expected.enum) !== JSON.stringify(got?.enum)) {
    out.push({ path: path + '.enum', expected: expected.enum, got: got?.enum })
  }
  if (Object.hasOwn(expected, 'required')) {
    const e = (expected.required ?? []).slice().sort()
    const g = (got?.required ?? []).slice().sort()
    if (JSON.stringify(e) !== JSON.stringify(g)) {
      out.push({ path: path + '.required', expected: expected.required, got: got?.required })
    }
  }
  if (Object.hasOwn(expected, 'additionalProperties') && expected.additionalProperties !== got?.additionalProperties) {
    out.push({ path: path + '.additionalProperties', expected: expected.additionalProperties, got: got?.additionalProperties })
  }
  if (Object.hasOwn(expected, 'properties')) {
    const gotProps = got?.properties ?? {}
    for (const [key, value] of Object.entries(expected.properties)) {
      if (!Object.hasOwn(gotProps, key)) {
        out.push({ path: path + '.properties.' + key, expected: value, got: undefined })
        continue
      }
      diffNode(value, gotProps[key], path + '.properties.' + key, out)
    }
    for (const key of Object.keys(gotProps)) {
      if (!Object.hasOwn(expected.properties, key)) {
        out.push({ path: path + '.properties.' + key, expected: undefined, got: gotProps[key] })
      }
    }
  }
  if (Object.hasOwn(expected, 'items')) {
    if (got?.items === undefined) {
      out.push({ path: path + '.items', expected: expected.items, got: undefined })
    } else {
      diffNode(expected.items, got.items, path + '.items', out)
    }
  }
}

const fmt = (value) => (value === undefined ? 'undefined' : typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value))

// compare each fixture tool
const failures = []
const documented = []
let toolCount = 0

for (const [toolName, expectedTool] of Object.entries(fixture.tools)) {
  toolCount++
  const tool = byName[toolName]
  if (tool === undefined) {
    failures.push({ tool: toolName, path: '<registered>', detail: 'tool not registered' })
    continue
  }

  const mismatches = []
  if (tool.description !== expectedTool.description) {
    mismatches.push({ path: 'description', expected: expectedTool.description, got: tool.description })
  }

  if (expectedTool.freeform === true) {
    // apply_patch: official is FREEFORM (no parameters schema); DSH registers
    // parameters.patch. Only the description is compared; the parameter shape
    // difference is recorded below as a documented difference.
    for (const m of mismatches) {
      const reason = isExempt({ tool: toolName, ...m })
      if (reason) documented.push({ tool: toolName, ...m, reason })
      else failures.push({ tool: toolName, ...m, detail: fmt(m.expected) + ' vs ' + fmt(m.got) })
    }
    documented.push({ tool: toolName, path: 'parameters', expected: null, got: tool.parameters, reason: 'official apply_patch is FREEFORM (no parameters schema); DSH registers parameters.patch (only description compared)' })
    continue
  }

  const expectedParams = {
    type: 'object',
    properties: expectedTool.properties,
    required: expectedTool.required,
    additionalProperties: expectedTool.additionalProperties,
  }
  diffNode(expectedParams, tool.parameters, 'parameters', mismatches)

  for (const m of mismatches) {
    const reason = isExempt({ tool: toolName, ...m })
    if (reason) documented.push({ tool: toolName, ...m, reason })
    else failures.push({ tool: toolName, ...m, detail: fmt(m.expected) + ' vs ' + fmt(m.got) })
  }
}

// report
console.log('tool schema alignment vs codex HEAD 5bc8da6d78')
console.log('  tools compared: ' + toolCount + ' (' + Object.keys(fixture.tools).join(', ') + ')')

if (documented.length > 0) {
  console.log('  documented differences (exempt): ' + documented.length)
  for (const d of documented) {
    console.log('    [' + d.tool + '] ' + d.path + ' :: expected ' + fmt(d.expected) + ' | got ' + fmt(d.got) + ' | reason: ' + d.reason)
  }
}

if (failures.length > 0) {
  console.error('MISMATCHES vs codex HEAD (' + failures.length + '):')
  for (const f of failures) {
    if (f.detail) console.error('  [' + f.tool + '] ' + f.path + ': ' + f.detail)
    else console.error('  [' + f.tool + '] ' + f.path + ': expected ' + fmt(f.expected) + ' vs got ' + fmt(f.got))
  }
  process.exit(1)
}

console.log('tool schema alignment: ALL PASS (' + toolCount + ' tools; ' + documented.length + ' documented differences exempt)')
