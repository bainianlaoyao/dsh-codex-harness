/**
 * Smoke test for plugins/tools/share-cordis-inspect.js.
 *
 * Covers: first register still succeeds, a duplicate Service/Event id is
 * skipped with a no-op disposer, unrelated errors still throw, and fiber
 * dispose restores the original register.
 */
import assert from 'node:assert/strict'
import { shareInspectRegister, name, inject, apply } from './share-cordis-inspect.js'

assert.equal(name, 'share-cordis-inspect')
assert.deepEqual(inject, ['cordisInspect'])

const seen = []
function throwingRegister(registration) {
  const id = registration.manifest.id
  if (seen.includes(id)) {
    throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
  }
  seen.push(id)
  return () => {
    const index = seen.indexOf(id)
    if (index >= 0) seen.splice(index, 1)
  }
}

const shared = shareInspectRegister(throwingRegister)
const first = shared({ manifest: { id: 'Service' } })
assert.equal(typeof first, 'function')
assert.deepEqual(seen, ['Service'])

const second = shared({ manifest: { id: 'Service' } })
assert.equal(typeof second, 'function')
assert.deepEqual(seen, ['Service'])
second()
assert.deepEqual(seen, ['Service'])

assert.throws(
  () => shareInspectRegister(() => { throw new Error('boom') })({ manifest: { id: 'Service' } }),
  /boom/,
)

const inspect = { register: throwingRegister }
const effects = []
apply({
  cordisInspect: inspect,
  effect(setup) {
    const dispose = setup()
    effects.push(dispose)
    return dispose
  },
})
assert.notEqual(inspect.register, throwingRegister)
inspect.register({ manifest: { id: 'Event' } })
inspect.register({ manifest: { id: 'Event' } })
assert.deepEqual(seen, ['Service', 'Event'])
for (const dispose of effects) dispose()
assert.equal(inspect.register, throwingRegister)

console.log('share-cordis-inspect smoke test: ALL PASS')
