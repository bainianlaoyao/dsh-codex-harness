/**
 * Alignment test: dsh-codex exec-policy vs codex official HEAD golden data.
 *
 * Reads fixtures extracted from the official codex unit tests
 * (shell-command/src/command_safety/is_safe_command.rs and
 * is_dangerous_command.rs, HEAD 5bc8da6d78) and asserts the DSH port
 * (policy/exec-policy.js) reproduces every decision. `platform`-tagged cases
 * run under both platforms (all) or only the tagged one.
 *
 * Usage: node dsh-codex/alignment/exec-policy.alignment.smoke.js
 *        (from the profile root)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDangerousCommand, isSafeCommand } from '../policy/exec-policy.js'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const safe = load('exec-policy.safe.json')
const dangerous = load('exec-policy.dangerous.json')

const failures = []
const run = (fixture, fn, platform, caseEntry) => {
  for (const c of caseEntry.cases) {
    if (c.platform !== 'all' && c.platform !== platform) continue
    const got = fn(c.argv, { platform })
    if (got !== c.expect) {
      failures.push({ fixture, platform, argv: c.argv, expect: c.expect, got, ref: c.ref })
    }
  }
}

for (const platform of ['linux', 'win32']) {
  run('safe', isSafeCommand, platform, safe)
  run('dangerous', isDangerousCommand, platform, dangerous)
}

if (failures.length > 0) {
  console.error(`MISMATCHES vs codex HEAD (${failures.length}):`)
  for (const f of failures) {
    console.error(`  [${f.fixture}/${f.platform}] ${JSON.stringify(f.argv)} expect=${f.expect} got=${f.got} (ref: ${f.ref})`)
  }
  process.exit(1)
}

const safeCount = ['linux', 'win32'].reduce((n, p) => n + safe.cases.filter((c) => c.platform === 'all' || c.platform === p).length, 0)
const dangerCount = ['linux', 'win32'].reduce((n, p) => n + dangerous.cases.filter((c) => c.platform === 'all' || c.platform === p).length, 0)
console.log(`exec-policy alignment: ALL PASS (${safeCount} safe + ${dangerCount} dangerous cases, linux+win32)`)
