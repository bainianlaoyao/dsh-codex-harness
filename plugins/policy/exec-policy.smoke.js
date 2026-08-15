/**
 * Smoke test for dsh-codex/policy/exec-policy.js — a battery of whitelist /
 * blacklist / classification cases taken from the codex research report
 * (§1.3 safe list, §1.5 Windows forms) and the decision table (§7.1/§7.2).
 *
 * Usage: node dsh-codex/policy/exec-policy.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const { DECISION, classify, isSafeCommand, isDangerousCommand, canonicalize, parseBashLc } = await import('./exec-policy.js')

const LINUX = { platform: 'linux' }
const safe = (argv) => assert.equal(isSafeCommand(argv, LINUX), true, `expected safe: ${argv.join(' ')}`)
const notSafe = (argv) => assert.equal(isSafeCommand(argv, LINUX), false, `expected not safe: ${argv.join(' ')}`)
const dangerous = (argv) => assert.equal(isDangerousCommand(argv, LINUX), true, `expected dangerous: ${argv.join(' ')}`)
const notDangerous = (argv) => assert.equal(isDangerousCommand(argv, LINUX), false, `expected not dangerous: ${argv.join(' ')}`)

// ── safe whitelist ─────────────────────────────────────────────────────────
for (const cmd of ['cat f', 'cd /tmp', 'echo hi', 'grep x f', 'ls -la', 'wc -l f', 'whoami', 'true', 'false']) safe(cmd.split(' '))
safe(['pwd'])
notSafe(['ls; rm -rf /', ''])
notSafe(['vim', 'f'])
notSafe(['touch', 'f'])

// git rules
safe(['git', 'status'])
safe(['git', 'log', '--oneline'])
safe(['git', 'branch'])
safe(['git', 'branch', '-a'])
safe(['git', 'branch', '--format=x'])
safe(['git', 'show', 'HEAD'])
notSafe(['git', 'push'])
notSafe(['git', 'commit'])
notSafe(['git', 'branch', 'new-branch'])
notSafe(['git', '-C', '/etc', 'status'])
notSafe(['git', 'status', '--exec', 'x'])

// special forms
safe(['base64', 'file'])
notSafe(['base64', '-o', 'out'])
notSafe(['base64', '--output=out'])
safe(['find', '.', '-name', 'x'])
notSafe(['find', '.', '-delete'])
notSafe(['find', '.', '-exec', 'rm', '{}', ';'])
safe(['rg', 'pattern'])
notSafe(['rg', '--pre', 'pattern'])
safe(['sed', '-n', '5,10p', 'f'])
notSafe(['sed', '-i', 's/a/b/', 'f'])

// bash -lc wrappers
safe(['bash', '-lc', 'ls && git status'])
notSafe(['bash', '-lc', 'ls > out.txt'])
notSafe(['bash', '-lc', 'curl http://x'])

// ── dangerous blacklist ────────────────────────────────────────────────────
dangerous(['rm', '-rf', 'x'])
dangerous(['rm', '-f', 'x'])
dangerous(['rm', '--force', 'x'])
dangerous(['sudo', 'rm', '-rf', '/etc'])
dangerous(['env', 'A=1', 'rm', '-f', 'x'])
dangerous(['bash', '-lc', 'ls; rm -rf x'])
dangerous(['bash', '-lc', "trap 'rm -rf /tmp/x' EXIT; sleep 1"])
notDangerous(['rm', 'x'])
notDangerous(['rm', '-r', 'x']) // -r without -f is not in the codex blacklist
notDangerous(['git', 'clean', '-fd'])

// windows forms
const WIN = { platform: 'win32' }
assert.equal(isDangerousCommand(['Remove-Item', 'x', '-Force'], WIN), true)
assert.equal(isDangerousCommand(['del', '/f', 'x'], WIN), true)
assert.equal(isDangerousCommand(['rd', '/s', '/q', 'x'], WIN), true)
assert.equal(isDangerousCommand(['Start-Process', 'https://example.com'], WIN), true)
assert.equal(isDangerousCommand(['Remove-Item', 'x'], WIN), false)

// windows safe
assert.equal(isSafeCommand(['pwsh', '-Command', 'Get-Content', 'f'], { platform: 'win32' }), false, 'pwsh -Command not in whitelist')
assert.equal(isSafeCommand(['pwsh', 'Get-Content', 'f'], { platform: 'win32' }), true)

// ── canonicalization ───────────────────────────────────────────────────────
assert.deepEqual(canonicalize(['bash', '-lc', 'git status']), ['git', 'status'])
assert.deepEqual(canonicalize(['bash', '-lc', 'a; b; c']), ['__codex_shell_script__', 'bash', 'a; b; c'])
assert.deepEqual(canonicalize(['ls', '-la']), ['ls', '-la'])

// ── classification matrix ──────────────────────────────────────────────────
const ls = ['ls', '-la']
const rmrf = ['rm', '-rf', 'x']
const unknown = ['curl', 'http://x']

assert.equal(classify(ls, { policy: 'untrusted', platform: 'linux' }).decision, DECISION.allow)
assert.equal(classify(unknown, { policy: 'untrusted', sandboxRestricted: true, platform: 'linux' }).decision, DECISION.prompt)
assert.equal(classify(unknown, { policy: 'untrusted', sandboxRestricted: false, platform: 'linux' }).decision, DECISION.prompt)
assert.equal(classify(rmrf, { policy: 'untrusted', platform: 'linux' }).decision, DECISION.prompt)
assert.equal(classify(rmrf, { policy: 'never', platform: 'linux' }).decision, DECISION.forbidden)
assert.equal(classify(unknown, { policy: 'never', sandboxRestricted: true, platform: 'linux' }).decision, DECISION.allow)
assert.equal(classify(unknown, { policy: 'never', sandboxRestricted: false, platform: 'linux' }).decision, DECISION.allow)
assert.equal(classify(unknown, { policy: 'on-request', sandboxRestricted: true, platform: 'linux' }).decision, DECISION.allow)
assert.equal(classify(unknown, { policy: 'on-request', sandboxRestricted: true, requestsEscalation: true, platform: 'linux' }).decision, DECISION.prompt)
assert.equal(classify(unknown, { policy: 'on-request', sandboxRestricted: false, platform: 'linux' }).decision, DECISION.allow)
assert.equal(classify(ls, { policy: 'never', platform: 'linux' }).decision, DECISION.allow)

console.log('exec-policy smoke test: ALL PASS')
