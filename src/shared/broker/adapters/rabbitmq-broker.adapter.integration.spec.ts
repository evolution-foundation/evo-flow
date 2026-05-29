/**
 * Integration tests for RabbitMQBrokerAdapter against a real RabbitMQ broker.
 *
 * Opt-in: set `RABBITMQ_INTEGRATION=1` to enable. Otherwise this file describes
 * a single skipped suite so the runner doesn't fail in CI without RabbitMQ.
 *
 * Local setup:
 *   docker compose -f docker/docker-compose.rabbitmq.yml up -d
 *   RABBITMQ_INTEGRATION=1 \
 *     RABBITMQ_URL=amqp://admin:admin@localhost:5672 \
 *     npm test -- rabbitmq-broker.adapter.integration.spec
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { RabbitMQBrokerAdapter } from './rabbitmq-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';
import { BrokerMessage } from '../interfaces/message-broker.interface';

const integrationEnabled = process.env.RABBITMQ_INTEGRATION === '1';
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('RabbitMQBrokerAdapter (integration)', () => {
  const url = process.env.RABBITMQ_URL ?? 'amqp://admin:admin@localhost:5672';
  const topicSuffix = Date.now();

  async function buildLiveAdapter(env: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => env],
        }),
      ],
      providers: [BrokerMetrics, RabbitMQBrokerAdapter],
    }).compile();
    const built = moduleRef.get(RabbitMQBrokerAdapter);
    return {
      adapter: built,
      close: () => moduleRef.close(),
    };
  }

  it('AC1: publish → consumer receives JSON payload', async () => {
    const { adapter, close } = await buildLiveAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: url,
      RUN_MODE: 'integration-ac1',
    });
    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    const topic = `int-publish-${topicSuffix}`;
    const received: BrokerMessage<{ foo: string }>[] = [];

    await adapter.subscribe<{ foo: string }>(topic, (msg) => {
      received.push(msg);
      return adapter.ack(msg);
    });

    await adapter.publish(topic, { foo: 'bar' });

    await waitFor(() => received.length > 0, 10_000);
    expect(received[0].payload.foo).toBe('bar');
    expect(received[0].headers.correlationId).toEqual(expect.any(String));
    expect(received[0].headers.messageId).toEqual(expect.any(String));

    await (
      adapter as unknown as { onModuleDestroy: () => Promise<void> }
    ).onModuleDestroy();
    await close();
  }, 30_000);

  it('AC2: nack(requeue=true) causes re-delivery', async () => {
    const { adapter, close } = await buildLiveAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: url,
      RUN_MODE: 'integration-ac2',
    });
    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    const topic = `int-nack-${topicSuffix}`;
    let firstSeen: BrokerMessage<{ n: number }> | null = null;
    const deliveries: number[] = [];

    await adapter.subscribe<{ n: number }>(topic, async (msg) => {
      deliveries.push(msg.payload.n);
      if (firstSeen === null) {
        firstSeen = msg;
        await adapter.nack(msg, true);
        return;
      }
      await adapter.ack(msg);
    });

    await adapter.publish(topic, { n: 42 });

    await waitFor(() => deliveries.length >= 2, 15_000);
    expect(deliveries[0]).toBe(42);
    expect(deliveries[1]).toBe(42);

    await (
      adapter as unknown as { onModuleDestroy: () => Promise<void> }
    ).onModuleDestroy();
    await close();
  }, 30_000);

  it('AC3: connection drop mid-operation triggers auto-reconnect under 5s', async () => {
    const { adapter, close } = await buildLiveAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: url,
      RUN_MODE: 'integration-ac3',
    });
    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    const topic = `int-drop-${topicSuffix}`;
    const deliveries: number[] = [];

    await adapter.subscribe<{ n: number }>(topic, (msg) => {
      deliveries.push(msg.payload.n);
      return adapter.ack(msg);
    });

    await adapter.publish(topic, { n: 1 });
    await waitFor(() => deliveries.length >= 1, 10_000);

    // Drop the connection by force-closing the underlying amqplib connection
    // through a sibling control channel. This simulates a broker-initiated
    // disconnect that the adapter should recover from.
    const controlConn = await amqplib.connect(url);
    await controlConn.close();
    // Direct access to the adapter's connection via reflection — test only.
    const internal = adapter as unknown as {
      connection: { close: () => Promise<void> } | null;
    };
    if (internal.connection) {
      await internal.connection.close();
    }

    // AC3 literal: reconnect must complete in under 5s. Give waitFor a small
    // margin (5.5s) so a near-budget reconnect still surfaces via the assert,
    // but enforce the <5000ms bound on the measurement itself.
    const reconnectStart = Date.now();
    await waitFor(
      () => (adapter as unknown as { active: boolean }).active === true,
      5_500,
    );
    const reconnectMs = Date.now() - reconnectStart;
    expect(reconnectMs).toBeLessThan(5_000);

    await adapter.publish(topic, { n: 2 });
    await waitFor(() => deliveries.length >= 2, 10_000);
    expect(deliveries).toContain(2);

    await (
      adapter as unknown as { onModuleDestroy: () => Promise<void> }
    ).onModuleDestroy();
    await close();
  }, 45_000);
});

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
