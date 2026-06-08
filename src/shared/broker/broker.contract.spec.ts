/**
 * Broker contract suite (EVO-1199) — the Epic 1 quality gate.
 *
 * Runs the SAME set of transport-invariant scenarios against every concrete
 * `IMessageBroker` adapter (Kafka, RabbitMQ) so the abstraction is proven
 * end-to-end before any downstream Epic builds business logic on it
 * (FR42, FR43, FR44).
 *
 * Opt-in, because it needs real brokers:
 *   - `BROKER_CONTRACT=1` enables the 6 deterministic scenarios (the merge gate).
 *   - `BROKER_CONTRACT_RESTART=1` additionally enables the broker-restart
 *     reconnect scenario, which `docker restart`s the broker mid-test and is
 *     therefore heavier/slower — kept out of the default gate on purpose.
 *
 * Local setup (see src/shared/broker/README.md for the full walkthrough):
 *   docker compose -f docker-compose.contract.yml up -d
 *   BROKER_CONTRACT=1 \
 *     KAFKA_BROKERS=localhost:9092 \
 *     RABBITMQ_URL=amqp://admin:admin@localhost:5672 \
 *     npm test -- broker.contract.spec
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import * as amqplib from 'amqplib';
import { KafkaBrokerAdapter } from './adapters/kafka-broker.adapter';
import { RabbitMQBrokerAdapter } from './adapters/rabbitmq-broker.adapter';
import { BrokerMetrics } from './metrics/broker-metrics';
import {
  BrokerMessage,
  IMessageBroker,
} from './interfaces/message-broker.interface';

const contractEnabled = process.env.BROKER_CONTRACT === '1';
const describeContract = contractEnabled ? describe : describe.skip;
const restartEnabled = process.env.BROKER_CONTRACT_RESTART === '1';

const execFileAsync = promisify(execFile);

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';
const RABBITMQ_URL =
  process.env.RABBITMQ_URL ?? 'amqp://admin:admin@localhost:5672';

interface BrokerHarness {
  adapter: IMessageBroker;
  metrics: BrokerMetrics;
  destroy: () => Promise<void>;
}

/** Builds a live, connected adapter bound to a fresh Nest module. */
type AdapterFactory = (runMode: string) => Promise<BrokerHarness>;

/** Best-effort removal of broker-side topics/queues created by a test. */
type Cleanup = (topic: string, runMode: string) => Promise<void>;

interface BrokerCase {
  name: string;
  factory: AdapterFactory;
  cleanup: Cleanup;
  /** Wait after `subscribe` before publishing. Kafka needs the group
   *  rebalance to settle (latest-offset reset skips earlier publishes). */
  settleMs: number;
  /** Docker container name to `docker restart` in the reconnect scenario. */
  container: string;
  /** Upper bound for the broker to come back and the adapter to recover. */
  restartRecoveryMs: number;
  /**
   * Pre-create the topic with a single partition (Kafka) before the durability
   * test. Kafka's default round-robin partitioner would otherwise spread the
   * two messages across partitions, leaving the un-acked one on a partition
   * with no committed offset — which a restarted consumer skips (latest reset).
   * A single partition keeps the committed baseline ahead of the un-acked
   * message so it is re-delivered. No-op for RabbitMQ (single durable queue).
   */
  prepareSinglePartitionTopic: (topic: string) => Promise<void>;
}

async function buildHarness<A extends IMessageBroker>(
  provider: new (...args: never[]) => A,
  env: Record<string, string>,
): Promise<BrokerHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
    ],
    providers: [BrokerMetrics, provider],
  }).compile();

  const adapter = moduleRef.get(provider);
  const metrics = moduleRef.get(BrokerMetrics);
  await (
    adapter as unknown as { onModuleInit: () => Promise<void> }
  ).onModuleInit();

  return {
    adapter,
    metrics,
    destroy: async () => {
      await (
        adapter as unknown as { onModuleDestroy: () => Promise<void> }
      ).onModuleDestroy();
      await moduleRef.close();
    },
  };
}

const kafkaCase: BrokerCase = {
  name: 'kafka',
  settleMs: 5_000,
  container: process.env.KAFKA_CONTRACT_CONTAINER ?? 'evo-campaign-kafka',
  restartRecoveryMs: 90_000,
  factory: (runMode) =>
    buildHarness(KafkaBrokerAdapter, {
      BROKER_TYPE: 'kafka',
      KAFKA_BROKERS,
      RUN_MODE: runMode,
    }),
  cleanup: async (topic) => {
    const admin = new Kafka({
      clientId: 'broker-contract-cleanup',
      brokers: KAFKA_BROKERS.split(',').map((s) => s.trim()),
    }).admin();
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [topic] });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  },
  prepareSinglePartitionTopic: async (topic) => {
    const admin = new Kafka({
      clientId: 'broker-contract-prepare',
      brokers: KAFKA_BROKERS.split(',').map((s) => s.trim()),
    }).admin();
    try {
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  },
};

const rabbitCase: BrokerCase = {
  name: 'rabbitmq',
  settleMs: 500,
  container: process.env.RABBITMQ_CONTRACT_CONTAINER ?? 'evo-campaign-rabbitmq',
  restartRecoveryMs: 30_000,
  factory: (runMode) =>
    buildHarness(RabbitMQBrokerAdapter, {
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL,
      RUN_MODE: runMode,
    }),
  cleanup: async (topic, runMode) => {
    const conn = await amqplib.connect(RABBITMQ_URL);
    try {
      const ch = await conn.createChannel();
      await ch.deleteQueue(`${runMode}-${topic}`).catch(() => undefined);
      await ch.deleteExchange(topic).catch(() => undefined);
      await ch.close().catch(() => undefined);
    } finally {
      await conn.close().catch(() => undefined);
    }
  },
  prepareSinglePartitionTopic: () => Promise.resolve(),
};

describeContract('Broker contract suite', () => {
  describe.each([
    ['kafka', kafkaCase],
    ['rabbitmq', rabbitCase],
  ])('%s adapter', (_label, broker) => {
    describeBrokerContract(broker);
  });
});

function describeBrokerContract(broker: BrokerCase): void {
  let seq = 0;
  const pending: Array<{ topic: string; runMode: string }> = [];

  function newScope(tag: string): { topic: string; runMode: string } {
    seq += 1;
    const stamp = `${Date.now()}-${seq}`;
    const scope = {
      topic: `contract.${broker.name}.${tag}.${stamp}`,
      runMode: `contract-${tag}-${stamp}`,
    };
    pending.push(scope);
    return scope;
  }

  afterEach(async () => {
    // Unique per-test names already prevent cross-run drift; this best-effort
    // pass keeps the broker from accumulating dead topics/queues over time.
    while (pending.length > 0) {
      const scope = pending.pop()!;
      await broker.cleanup(scope.topic, scope.runMode).catch(() => undefined);
    }
  });

  it('publish + subscribe preserves payload types round-trip', async () => {
    const { topic, runMode } = newScope('roundtrip');
    const h = await broker.factory(runMode);
    const received: BrokerMessage<ContractPayload>[] = [];

    try {
      await h.adapter.subscribe<ContractPayload>(topic, (msg) => {
        received.push(msg);
        return h.adapter.ack(msg);
      });
      await sleep(broker.settleMs);

      const payload: ContractPayload = {
        str: 'hello',
        num: 42,
        bool: true,
        nested: { tags: ['a', 'b'], count: 3 },
      };
      await h.adapter.publish(topic, payload);

      await waitFor(() => received.length > 0, 20_000);
      expect(received[0].payload).toEqual(payload);
      expect(received[0].headers.correlationId).toEqual(expect.any(String));
      expect(received[0].headers.messageId).toEqual(expect.any(String));
    } finally {
      await h.destroy();
    }
  }, 45_000);

  it('ack removes the message (not re-delivered)', async () => {
    const { topic, runMode } = newScope('ack');
    const h = await broker.factory(runMode);
    const deliveries: number[] = [];

    try {
      await h.adapter.subscribe<{ n: number }>(topic, (msg) => {
        deliveries.push(msg.payload.n);
        return h.adapter.ack(msg);
      });
      await sleep(broker.settleMs);

      await h.adapter.publish(topic, { n: 7 });
      await waitFor(() => deliveries.length >= 1, 20_000);

      // Grace window: if ack didn't take, a re-delivery would arrive here.
      await sleep(4_000);
      expect(deliveries).toEqual([7]);
    } finally {
      await h.destroy();
    }
  }, 45_000);

  it('nack(requeue=true) re-delivers the message', async () => {
    const { topic, runMode } = newScope('requeue');
    const h = await broker.factory(runMode);
    const deliveries: number[] = [];
    let firstSeen = false;

    try {
      await h.adapter.subscribe<{ n: number }>(topic, async (msg) => {
        deliveries.push(msg.payload.n);
        if (!firstSeen) {
          firstSeen = true;
          await h.adapter.nack(msg, true);
          return;
        }
        await h.adapter.ack(msg);
      });
      await sleep(broker.settleMs);

      await h.adapter.publish(topic, { n: 42 });

      await waitFor(() => deliveries.length >= 2, 25_000);
      expect(deliveries[0]).toBe(42);
      expect(deliveries[1]).toBe(42);
    } finally {
      await h.destroy();
    }
  }, 50_000);

  it('nack(requeue=false) drops the message and increments terminal_failures', async () => {
    const { topic, runMode } = newScope('terminal');
    const h = await broker.factory(runMode);
    const deliveries: number[] = [];

    try {
      const before = await counterValue(h.metrics, broker.name, topic);

      await h.adapter.subscribe<{ n: number }>(topic, (msg) => {
        deliveries.push(msg.payload.n);
        return h.adapter.nack(msg, false);
      });
      await sleep(broker.settleMs);

      await h.adapter.publish(topic, { n: 99 });
      await waitFor(() => deliveries.length >= 1, 20_000);

      // No DLQ at broker level (blocker scope) → drop + metric. The drop is
      // proven by the absence of a re-delivery in the grace window.
      await sleep(4_000);
      expect(deliveries).toEqual([99]);

      const after = await counterValue(h.metrics, broker.name, topic);
      expect(after - before).toBe(1);
    } finally {
      await h.destroy();
    }
  }, 45_000);

  it('message survives a consumer restart (durability + at-least-once)', async () => {
    const { topic, runMode } = newScope('durability');
    await broker.prepareSinglePartitionTopic(topic);
    const first = await broker.factory(runMode);
    const seenByFirst: number[] = [];
    const seenBySecond: number[] = [];

    try {
      // Establish a committed baseline so Kafka has a concrete resume offset:
      // m1 is acked, m2 is received-but-not-acked, then the consumer dies.
      await first.adapter.subscribe<{ n: number }>(topic, async (msg) => {
        seenByFirst.push(msg.payload.n);
        if (msg.payload.n === 1) {
          await first.adapter.ack(msg);
        }
        // m2 (n=2) is intentionally left un-acked.
      });
      await sleep(broker.settleMs);

      await first.adapter.publish(topic, { n: 1 });
      await waitFor(() => seenByFirst.includes(1), 20_000);
      await first.adapter.publish(topic, { n: 2 });
      await waitFor(() => seenByFirst.includes(2), 20_000);
    } finally {
      await first.destroy();
    }

    // New consumer in the same group/queue must receive the un-acked m2.
    const second = await broker.factory(runMode);
    try {
      await second.adapter.subscribe<{ n: number }>(topic, (msg) => {
        seenBySecond.push(msg.payload.n);
        return second.adapter.ack(msg);
      });

      await waitFor(() => seenBySecond.includes(2), 25_000);
      expect(seenBySecond).toContain(2);
      expect(seenBySecond).not.toContain(1); // m1 was acked, must not re-deliver
    } finally {
      await second.destroy();
    }
  }, 90_000);

  it('multiple consumers load-balance without loss or duplication', async () => {
    const { topic, runMode } = newScope('loadbalance');
    const total = 10;
    const consumerA = await broker.factory(runMode);
    const consumerB = await broker.factory(runMode);
    const byA: number[] = [];
    const byB: number[] = [];

    try {
      await consumerA.adapter.subscribe<{ n: number }>(topic, (msg) => {
        byA.push(msg.payload.n);
        return consumerA.adapter.ack(msg);
      });
      await consumerB.adapter.subscribe<{ n: number }>(topic, (msg) => {
        byB.push(msg.payload.n);
        return consumerB.adapter.ack(msg);
      });
      await sleep(broker.settleMs);

      for (let n = 1; n <= total; n += 1) {
        await consumerA.adapter.publish(topic, { n });
      }

      await waitFor(() => byA.length + byB.length >= total, 30_000);
      // Hard invariant: every message delivered exactly once across the group.
      const union = [...byA, ...byB].sort((a, b) => a - b);
      expect(union).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      // Load-balancing claim: both consumers did work.
      expect(byA.length).toBeGreaterThan(0);
      expect(byB.length).toBeGreaterThan(0);
    } finally {
      await consumerA.destroy();
      await consumerB.destroy();
    }
  }, 60_000);

  const itRestart = restartEnabled ? it : it.skip;
  itRestart(
    'reconnects and resumes delivery after a broker restart',
    async () => {
      const { topic, runMode } = newScope('reconnect');
      // Single partition so the committed offset from n1's ack covers n2 after
      // the restart — otherwise Kafka's round-robin could land n2 on a
      // partition with no committed offset, which the resumed consumer skips
      // (latest reset). Same baseline trick as the durability scenario.
      await broker.prepareSinglePartitionTopic(topic);
      const h = await broker.factory(runMode);
      const deliveries: number[] = [];

      try {
        await h.adapter.subscribe<{ n: number }>(topic, (msg) => {
          deliveries.push(msg.payload.n);
          return h.adapter.ack(msg);
        });
        await sleep(broker.settleMs);

        await h.adapter.publish(topic, { n: 1 });
        await waitFor(() => deliveries.includes(1), 20_000);

        // Must NOT block the event loop: the adapter's reconnect runs on
        // timers/close-handlers that need to fire while the broker is down.
        await dockerRestart(broker.container);

        // Publishing while the adapter recovers may throw (fail-fast). Retry
        // until the broker is back and the adapter is active again.
        await retryPublish(
          () => h.adapter.publish(topic, { n: 2 }),
          broker.restartRecoveryMs,
        );

        await waitFor(() => deliveries.includes(2), broker.restartRecoveryMs);
        expect(deliveries).toContain(2);
      } finally {
        await h.destroy();
      }
    },
    180_000,
  );
}

interface ContractPayload {
  str: string;
  num: number;
  bool: boolean;
  nested: { tags: string[]; count: number };
}

async function counterValue(
  metrics: BrokerMetrics,
  brokerName: string,
  topic: string,
): Promise<number> {
  const snapshot = await metrics.terminalFailures.get();
  const match = snapshot.values.find(
    (v) => v.labels.broker === brokerName && v.labels.topic === topic,
  );
  return match?.value ?? 0;
}

async function dockerRestart(container: string): Promise<void> {
  await execFileAsync('docker', ['restart', container]);
}

async function retryPublish(
  publish: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastErr: Error | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await publish();
      return;
    } catch (err) {
      lastErr = err as Error;
      await sleep(1_000);
    }
  }
  throw new Error(
    `publish did not succeed within ${timeoutMs}ms after restart: ${lastErr?.message}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
