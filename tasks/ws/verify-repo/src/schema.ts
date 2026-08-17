// Drizzle/Postgres schema for a minimal order stream (verify-repo demo).
// The live-verify task asks an agent to design an event-sourcing core on top
// of this: event envelope, aggregate version, outbox sketch.

import { pgTable, serial, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core'

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  customer: text('customer').notNull(),
  totalCents: integer('total_cents').notNull(),
  status: text('status', { enum: ['pending', 'paid', 'shipped', 'cancelled'] })
    .notNull()
    .default('pending'),
})

export const orderEvents = pgTable('order_events', {
  seq: serial('seq').primaryKey(),
  orderId: integer('order_id').references(() => orders.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})