/**
 * Alignment test: exec_command result text vs codex official HEAD format.
 *
 * Reads fixtures/extracted from codex ExecCommandToolOutput::response_text()
 * (core/src/tools/context.rs:442-468) and asserts tools/exec-command.js
 * renderExecResult reproduces the byte shape (section order, 4-decimal wall
 * time, `Output:` label, truncation prefix, no exit-code section on signal
 * death).
 *
 * Usage: node dsh-codex/alignment/exec-command.alignment.smoke.js
 *        (from the profile root)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderExecResult } from '../tools/exec-command.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/exec-command.format.json', import.meta.url), 'utf8'))

const failures = []
for (const c of fixture.cases) {
  const got = renderExecResult(c.value)
  if (got !== c.expect) failures.push({ name: c.name, got, expect: c.expect })
}

if (failures.length > 0) {
  console.error(`MISMATCHES vs codex HEAD (${failures.length}):`)
  for (const f of failures) {
    console.error(`  [${f.name}]`)
    console.error(`    expect: ${JSON.stringify(f.expect)}`)
    console.error(`    got:    ${JSON.stringify(f.got)}`)
  }
  process.exit(1)
}

console.log(`exec-command format alignment: ALL PASS (${fixture.cases.length} cases)`)
