import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent } from '../src/events.ts'

test('paid event moves the aggregate to paid', () => {
  const order = { id: 1, customer: 'a', totalCents: 100, status: 'pending' }
  const next = applyEvent(order, { type: 'order.paid' })
  assert.equal(next.status, 'paid')
})

test('unknown event type rejects', () => {
  assert.throws(() => applyEvent({ status: 'pending' }, { type: 'nope' }), /unknown event type/)
})