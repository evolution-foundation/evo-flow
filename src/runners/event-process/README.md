# event-process runner

Consumes `events.received.<platform>` and runs the webhook pipeline
(`RUN_MODE=event-process`):

```
envelope guard → signature validation (3.4) → idempotency dedup (3.5)
→ enrichment (3.6) → micro-batched ClickHouse INSERT into contact_events (3.7)
→ on exhausted retries: events.failed DLQ (3.8)
```

Drops (invalid signature, unknown platform, duplicates) ACK and never
redeliver. Per-provider webhook secrets are documented in the root
`.env.example` (`*_WEBHOOK_*`).

## events.failed (DLQ)

Any stage that decides "do not retry anymore" hands the event to
`DlqPublisherService`, which publishes one message **per event**:

```json
{
  "originalTopic": "events.received.evolution-api",
  "originalPayload": { "...": "the ENRICHED event (envelope + enrichment)" },
  "failureReason": "clickhouse_insert_exhausted_retries",
  "attempts": 3,
  "lastFailureAt": "2026-06-10T12:34:56.789Z",
  "correlationId": "<uuid>"
}
```

`originalPayload` carries the **enriched** event on purpose: a manual
reprocess can re-insert without re-running enrichment. `failureReason` follows
the `<system>_<action>_<outcome>` convention and is the label on the
`evo_events_failed_published_total{reason}` metric; a failed DLQ publish
itself increments `evo_dlq_publish_failed_total` — if that fires, the last
resort failed and an operator must look.

There is **no automatic consumer** in the MVP — operators inspect and
reprocess manually.

### Inspecting manually

Kafka (`kcat`):

```bash
# dump everything currently in the DLQ
kcat -b localhost:9092 -t events.failed -C -e | jq '.'

# filter by failure reason
kcat -b localhost:9092 -t events.failed -C -e \
  | jq 'select(.failureReason == "clickhouse_insert_exhausted_retries")'

# correlate one event end-to-end across logs
kcat -b localhost:9092 -t events.failed -C -e \
  | jq 'select(.correlationId == "<uuid>")'
```

RabbitMQ: Management UI → Queues → `events.failed` → *Get messages*
(requeue=true to peek without consuming), or `rabbitmqadmin get
queue=events.failed count=50`.

### Reprocessing caveats (read before re-publishing)

1. **Strip `enrichment` before re-publishing.** `originalPayload` is the
   ENRICHED event, but the `events.received` contract is `strict()` — an extra
   `enrichment` key makes the consumer reject the message as an invalid
   envelope (terminal drop). Replay the bare envelope:

   ```bash
   kcat -b localhost:9092 -t events.failed -C -e \
     | jq -c 'select(.correlationId == "<uuid>") | .originalPayload | del(.enrichment)' \
     | kcat -b localhost:9092 -t events.received.<platform> -P
   ```

2. **Idempotency TTL (1h):** re-publishing the envelope within 1 hour of the
   original attempt is **silently dropped as a duplicate** (the dedup hash
   covers `rawPayload` only). Either wait out the TTL, delete the idempotency
   key in Redis, or insert the row into ClickHouse directly.
3. **Signature validation re-runs** on the re-published envelope — the
   original `headers` are preserved inside `originalPayload`, so replaying the
   stripped envelope keeps the signature verifiable.
4. Inserting directly into ClickHouse: map the enriched event onto
   `contact_events` the same way the writer does (see
   `clickhouse-writer.service.ts` `toRow` — D1 mapping, `correlation_id`
   inside `properties`).
