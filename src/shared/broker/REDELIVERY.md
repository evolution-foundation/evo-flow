# Broker redelivery backstop (EVO-1677)

Defense-in-depth ceiling on redeliveries so a poison message can never block a
queue/partition indefinitely — independent of whether the application classified
the error as terminal (that is [EVO-1676](https://linear.app/evoai/issue/EVO-1676)'s
typed `TerminalError`). Implemented uniformly across both broker adapters via a
header-based attempt counter; no RabbitMQ quorum-queue migration required.

## How it works

On `nack(msg, requeue=true)`:

1. Read the `x-delivery-attempt` header (absent = 0) and compute `attempt + 1`.
2. **Under the limit** → republish the message to the **same** topic/queue with
   the incremented `x-delivery-attempt`, then ack/commit the original. The retry
   goes to the tail (it does not block the partition/queue head).
3. **At the limit** → publish to the DLQ/DLT instead, ack/commit the original,
   and increment `evo_broker_dead_lettered_total`.

`nack(msg, requeue=false)` is unchanged: an explicit terminal drop
(`evo_broker_terminal_failures_total`).

## Design decisions

- **Delivery limit:** env `BROKER_DELIVERY_LIMIT`, **default 3** (validated `>= 1`
  at boot). A message is processed up to N times, then dead-lettered on the Nth
  failure.
- **DLQ/DLT naming:** `<name>.dlq`. RabbitMQ uses `<queue>.dlq`
  (`<runMode>-<topic>.dlq`); Kafka uses `<topic>.dlq`. Dead-lettered messages
  carry `x-dlq-reason=delivery-limit-exceeded` and `x-original-topic` headers.
- **RabbitMQ mechanism:** republish via `sendToQueue` on the existing **classic
  durable** queues (no `x-delivery-limit`/quorum migration). The `<queue>.dlq` is
  a plain durable queue, asserted lazily on first dead-letter.
- **Kafka mechanism:** Kafka has no native delivery count and `seek` rewinds the
  partition behind the poison message; we republish via the producer and commit
  past the original so the partition keeps moving.
- **Metric:** `evo_broker_dead_lettered_total{broker,topic}` (counter), exposed on
  `/metrics` alongside `evo_broker_terminal_failures_total`.
- **Alert (DLQ depth):** alerting is external (Prometheus/Alertmanager, see
  story 5.3). Recommended rule on the exposed counter:
  `rate(evo_broker_dead_lettered_total[5m]) > 0` (any dead-letter is worth a
  page in the MVP). A true queue-depth **gauge** needs broker-admin polling and
  is deferred.
- **Replay / inspection policy (MVP):** manual. Dead-lettered messages sit in
  `<name>.dlq` for inspection; there is no automatic reprocessing consumer or
  replay UI/CLI yet (out of scope, see the card).

## Boundary vs `events.failed` (EVO-1214)

This transport-level backstop is orthogonal to the application-level
`events.failed` DLQ publisher: the latter is an explicit publish after the code
*decided* a failure is terminal; this card catches loops the code did **not**
classify. Routing the broker DLQ into `events.failed` is a future integration,
intentionally not done here.
