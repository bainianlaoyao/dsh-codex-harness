// Current event recording logic (verify-repo demo): appends an event row and
// patches the aggregate status. No versioning, no outbox — the intended seams
// the live-verify task's design should address.

export function applyEvent(order, event) {
  switch (event.type) {
    case 'order.paid':
      return { ...order, status: 'paid' }
    case 'order.shipped':
      return { ...order, status: 'shipped' }
    case 'order.cancelled':
      return { ...order, status: 'cancelled' }
    default:
      throw new Error(`unknown event type: ${event.type}`)
  }
}