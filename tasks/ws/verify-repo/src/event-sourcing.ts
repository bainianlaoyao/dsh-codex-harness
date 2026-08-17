/** A domain event must identify its stable, externally visible type. */
export interface DomainEvent<
  Type extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: Type;
  readonly data: Data;
}

/**
 * Immutable event-store record.
 *
 * Drizzle mapping: persist this as an `events` table with `id` as the primary
 * key and a unique composite index on (`aggregate_type`, `aggregate_id`,
 * `aggregate_version`). Store `event.type`, `event.data`, and `metadata` in
 * scalar/JSON columns; persist `occurredAt` in a timestamp column.
 */
export interface EventEnvelope<Event extends DomainEvent = DomainEvent> {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly event: Event;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
}

/** A reconstructed aggregate together with its last committed event version. */
export interface VersionedAggregate<State> {
  readonly state: State;
  readonly version: number;
}

/** Raised when another writer has appended events before the expected version. */
export class ConcurrencyError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(`Expected aggregate version ${expectedVersion}, received ${actualVersion}.`);
    this.name = "ConcurrencyError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Applies persisted event envelopes in their aggregate-version order. */
export function rehydrate<State, Event extends DomainEvent>(
  initialState: State,
  events: readonly EventEnvelope<Event>[],
  apply: (state: State, event: Event) => State,
): VersionedAggregate<State> {
  return events.reduce<VersionedAggregate<State>>(
    (aggregate, envelope) => ({
      state: apply(aggregate.state, envelope.event),
      version: envelope.aggregateVersion,
    }),
    { state: initialState, version: 0 },
  );
}

/**
 * Prepares new envelopes only after verifying the caller's loaded version.
 * The database adapter must repeat this check transactionally when inserting.
 */
export function appendEvents<Event extends DomainEvent>(
  aggregate: VersionedAggregate<unknown>,
  expectedVersion: number,
  identity: Pick<EventEnvelope<Event>, "aggregateType" | "aggregateId">,
  events: readonly Event[],
  createId: () => string,
  occurredAt = new Date(),
  metadata: Record<string, unknown> = {},
): readonly EventEnvelope<Event>[] {
  if (aggregate.version !== expectedVersion) {
    throw new ConcurrencyError(expectedVersion, aggregate.version);
  }

  return events.map((event, index) => ({
    id: createId(),
    ...identity,
    aggregateVersion: expectedVersion + index + 1,
    event,
    metadata,
    occurredAt,
  }));
}

/**
 * Publishable event copied to the outbox in the same database transaction.
 *
 * Drizzle mapping: persist this as an `outbox` table with `id` as its primary
 * key, `event_id` referencing `events.id`, a nullable `published_at`, and an
 * index on `published_at` for polling pending records. Serialize `payload`
 * to JSON, including its timestamps, or rebuild it from `event_id` on publish.
 */
export interface OutboxMessage<Event extends DomainEvent = DomainEvent> {
  readonly id: string;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: EventEnvelope<Event>;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

/** Builds outbox records; persist these with their envelopes atomically. */
export function toOutboxMessages<Event extends DomainEvent>(
  envelopes: readonly EventEnvelope<Event>[],
  topicFor: (event: EventEnvelope<Event>) => string,
  createId: () => string,
  createdAt = new Date(),
): readonly OutboxMessage<Event>[] {
  return envelopes.map((envelope) => ({
    id: createId(),
    eventId: envelope.id,
    topic: topicFor(envelope),
    payload: envelope,
    createdAt,
    publishedAt: null,
  }));
}
