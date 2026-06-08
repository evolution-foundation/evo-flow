# `src/shared/broker` — broker-agnostic transport

The pipeline talks to its message transport through a single interface,
`IMessageBroker`. Two concrete adapters implement it and are selected at boot
by the `BROKER_TYPE` env var:

| `BROKER_TYPE` | Adapter | Library |
| --- | --- | --- |
| `kafka` | `KafkaBrokerAdapter` | `kafkajs` |
| `rabbitmq` | `RabbitMQBrokerAdapter` | `amqplib` |

```ts
publish<T>(topic, payload): Promise<void>
subscribe<T>(topic, handler): Promise<void>
ack(msg): Promise<void>
nack(msg, requeue?): Promise<void>
```

Inject the broker via the `IMESSAGE_BROKER` token (exported by `BrokerModule`).
Adapters are interchangeable: the same call sites work against either broker.

## Transport invariants

The contract suite (`broker.contract.spec.ts`) proves these hold for **both**
adapters, so downstream Epics can rely on them:

- **Round-trip** — `publish` then `subscribe` preserves payload types; every
  message carries `correlationId` and `messageId` headers.
- **At-least-once** — `ack` removes a message; an un-acked message is
  re-delivered after a consumer restart (durability).
- **Requeue** — `nack(requeue=true)` re-delivers the message.
- **Terminal drop** — `nack(requeue=false)` drops the message (no broker-level
  DLQ at this layer) and increments `evo_broker_terminal_failures_total`.
- **Load balancing** — multiple consumers in the same group/queue split the
  load with no loss or duplication.
- **Reconnect** — the adapter recovers and resumes delivery after a broker
  restart.

## Environment variables

**Kafka** — `KAFKA_BROKERS` (required, comma-separated `host:port`),
`KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`,
`KAFKA_SSL_ENABLED`. Consumer groups are `${RUN_MODE}-${topic}`.

**RabbitMQ** — `RABBITMQ_URL` (required, `amqp://user:pass@host:port/vhost`),
`RABBITMQ_PREFETCH_COUNT` (default 100), `RABBITMQ_VHOST`. Durable queues are
`${RUN_MODE}-${topic}`, bound to a `topic` exchange named after the topic.

Set `RUN_MODE` so consumer groups/queues isolate per pipeline mode.

## Running the tests

There are three layers, each opt-in by an env flag so plain `npm test` (unit)
needs no brokers:

| Suite | Flag | Needs |
| --- | --- | --- |
| Unit (`*.adapter.spec.ts`) | — | nothing (mocked) |
| Per-adapter integration (`*.integration.spec.ts`) | `KAFKA_INTEGRATION=1` / `RABBITMQ_INTEGRATION=1` | one real broker |
| **Contract suite** (`broker.contract.spec.ts`) | `BROKER_CONTRACT=1` | both brokers |

### Contract suite locally

1. Start the brokers (self-contained compose, no external network needed):

   ```bash
   docker compose -f docker-compose.contract.yml up -d --wait
   ```

2. Run the 6 deterministic scenarios against both adapters:

   ```bash
   npm run test:contract
   # equivalent to:
   # BROKER_CONTRACT=1 jest --runInBand broker.contract.spec
   ```

   The suite defaults to `KAFKA_BROKERS=localhost:9092` and
   `RABBITMQ_URL=amqp://admin:admin@localhost:5672` (matching the compose);
   override either env var to point at a different broker.

3. (Optional) Also run the heavier broker-restart reconnect scenario, which
   `docker restart`s each broker mid-test:

   ```bash
   BROKER_CONTRACT=1 BROKER_CONTRACT_RESTART=1 \
     npx jest --runInBand broker.contract.spec -t "reconnects and resumes"
   ```

   It restarts the containers named `evo-campaign-kafka` /
   `evo-campaign-rabbitmq`; override with `KAFKA_CONTRACT_CONTAINER` /
   `RABBITMQ_CONTRACT_CONTAINER` if yours differ.

4. Tear down:

   ```bash
   docker compose -f docker-compose.contract.yml down -v
   ```

## CI merge gate

`.github/workflows/broker-contract.yml` runs on every PR/push touching
`src/shared/broker/**`:

- **`contract`** — boots both brokers and runs the 6 deterministic scenarios.
  This is the merge gate; mark it required in branch protection for
  `main`/`develop`.
- **`contract-reconnect`** — runs the broker-restart scenario with
  `continue-on-error: true` (non-blocking), so a flaky restart never wedges an
  otherwise-green PR.

> Branch-protection note: GitHub reports a path-filtered workflow as *pending*
> (not *success*) on PRs that don't touch the filtered paths. If you make
> `contract` a required check org-wide, pair it with a `paths-filter` step or a
> always-runs shim so unrelated PRs aren't blocked.

## Deploy: provisioning topics (EVO-1200)

Adapters create topics lazily on first publish/subscribe, but production should
provision the broker topology explicitly. Run this **once on the first deploy
to a fresh cluster, before any pipeline mode starts** (idempotent — safe to
re-run):

```bash
BROKER_TYPE=kafka    npm run broker:provision-topics
BROKER_TYPE=rabbitmq npm run broker:provision-topics
```

It boots a minimal Nest context with `BrokerModule` and calls
`IMessageBroker.provisionTopic` for the 7 canonical topics
(`ALL_CONTRACT_TOPIC_NAMES` + the `events.received` template root):

- **Kafka** — `admin.createTopics` (idempotent; `TOPIC_ALREADY_EXISTS` ignored).
- **RabbitMQ** — a durable `topic` exchange per name + a default durable queue
  (declared, **not bound**). Consumers bind their own `${runMode}-${topic}`
  queue on subscribe; binding the default queue here would make it accumulate a
  copy of every message with no consumer to drain it.

Per-platform `events.received.<platform>` topics stay dynamic — the
event-receiver creates them at runtime.
