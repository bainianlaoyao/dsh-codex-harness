/**
 * Smoke test for dsh-codex/tools/restrict.js — asserts the codex tool-surface
 * restriction denies exactly the host-global `bash` tool.
 *
 * Usage: node dsh-codex/tools/restrict.smoke.js  (from the profile root)
 */
import assert from 'node:assert/strict'

const restrictions = []
const ctx = {
  tools: {
    restrict(filter) {
      restrictions.push(filter)
      return () => {}
    },
  },
}

const { apply, name, inject } = await import('./restrict.js')
assert.equal(name, 'tool-codex-restrict')
assert.deepEqual(inject, ['tools'])
apply(ctx, {})
assert.equal(restrictions.length, 1, 'one restriction registered')
assert.deepEqual(restrictions[0].deny, ['bash'], 'denies exactly the host-global bash tool')

console.log('restrict smoke test: ALL PASS')
