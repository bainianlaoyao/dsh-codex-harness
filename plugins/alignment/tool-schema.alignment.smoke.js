/**
 * Alignment test: exec_command / write_stdin schema vs codex official HEAD.
 *
 * Reads fixtures/extracted from core/src/tools/handlers/shell_spec.rs and
 * asserts the DSH registered tool schemas match the official property-name
 * sets, required sets and value types (description text is not compared).
 *
 * Usage: node dsh-codex/alignment/tool-schema.alignment.smoke.js
 *        (from the profile root)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tool-schema.exec.json', import.meta.url), 'utf8'))
const { apply } = await import('../tools/exec-command.js')

const captured = []
apply({ tools: { register: (definition) => captured.push(definition) } }, { maxOutputChars: 100000 })
const byName = Object.fromEntries(captured.map((t) => [t.name, t]))

const failures = []
for (const [toolName, expected] of Object.entries(fixture.tools)) {
  const tool = byName[toolName]
  if (tool === undefined) {
    failures.push({ tool: toolName, detail: 'tool not registered' })
    continue
  }
  const params = tool.parameters.properties ?? {}
  const gotNames = Object.keys(params).sort()
  const wantNames = Object.keys(expected.properties).sort()
  if (JSON.stringify(gotNames) !== JSON.stringify(wantNames)) {
    failures.push({ tool: toolName, detail: `property names mismatch: expected ${JSON.stringify(wantNames)}, got ${JSON.stringify(gotNames)}` })
  }
  const gotRequired = (tool.parameters.required ?? []).slice().sort()
  const wantRequired = expected.required.slice().sort()
  if (JSON.stringify(gotRequired) !== JSON.stringify(wantRequired)) {
    failures.push({ tool: toolName, detail: `required mismatch: expected ${JSON.stringify(wantRequired)}, got ${JSON.stringify(gotRequired)}` })
  }
  for (const [name, wantType] of Object.entries(expected.properties)) {
    const got = params[name]
    if (got === undefined) continue
    if (got.type !== wantType) {
      failures.push({ tool: toolName, detail: `property ${name}: expected type ${wantType}, got ${got.type}` })
    }
  }
}

if (failures.length > 0) {
  console.error(`MISMATCHES vs codex HEAD (${failures.length}):`)
  for (const f of failures) console.error(`  [${f.tool}] ${f.detail}`)
  process.exit(1)
}

console.log(`tool schema alignment: ALL PASS (${Object.keys(fixture.tools).length} tools)`)
