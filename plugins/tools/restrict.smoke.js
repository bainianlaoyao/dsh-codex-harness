import assert from 'node:assert/strict'
import { apply } from './restrict.js'
for (const available of [true, false]) {
  const restrictions = []
  let assemble
  apply({ tools: { view: () => ({ restrictableNames: new Set(available ? ['bash'] : []) }), restrict: value => restrictions.push(value) }, on: (_name, fn) => { assemble = fn } })
  assert.deepEqual(restrictions, available ? [{ deny: ['bash'] }] : [])
  const assembly = { tools: [], sections: [{ name: 'tool:bash' }, { name: 'other' }] }
  assert.deepEqual((await assemble(assembly, {}, async () => assembly)).sections, [{ name: 'other' }])
  assembly.tools.push({ name: 'bash' })
  assert.equal(await assemble(assembly, {}, async () => assembly), assembly)
}
console.log('restrict: absent shell, scoped deny and matching guidance PASS')
