import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RabbitMQBrokerAdapter } from './rabbitmq-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';
import { BrokerMessage } from '../interfaces/message-broker.interface';

type ChannelMock = {
  assertExchange: jest.Mock;
  assertQueue: jest.Mock;
  bindQueue: jest.Mock;
  consume: jest.Mock;
  publish: jest.Mock;
  ack: jest.Mock;
  nack: jest.Mock;
  prefetch: jest.Mock;
  cancel: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
  __triggerMessage?: (
    raw: {
      content: Buffer | null;
      fields: { deliveryTag: number; routingKey?: string };
      properties: { headers?: Record<string, unknown> };
    } | null,
  ) => void;
  __triggerChannelError?: (err: Error) => void;
  __triggerChannelClose?: () => void;
};

type ConnectionMock = {
  createChannel: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
  __triggerClose?: () => void;
  __triggerError?: (err: Error) => void;
};

type ConnectionInstance = {
  args: { url: string; opts: { vhost?: string } | undefined };
  connection: ConnectionMock;
  channel: ChannelMock;
};

const mockState: {
  connectFailuresRemaining: number;
} = {
  connectFailuresRemaining: 0,
};

const connectionInstances: ConnectionInstance[] = [];

jest.mock('amqplib', () => {
  return {
    connect: jest
      .fn()
      .mockImplementation(
        (url: string, opts: { vhost?: string } | undefined) => {
          if (mockState.connectFailuresRemaining > 0) {
            mockState.connectFailuresRemaining--;
            return Promise.reject(new Error('mocked connect failure'));
          }
          const channel: ChannelMock = {
            assertExchange: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest
              .fn()
              .mockImplementation((name: string) =>
                Promise.resolve({ queue: name }),
              ),
            bindQueue: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockImplementation((_q, handler) => {
              channel.__triggerMessage =
                handler as ChannelMock['__triggerMessage'];
              return Promise.resolve({ consumerTag: `ctag-${Date.now()}` });
            }),
            publish: jest.fn().mockReturnValue(true),
            ack: jest.fn(),
            nack: jest.fn(),
            prefetch: jest.fn().mockResolvedValue(undefined),
            cancel: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            on: jest
              .fn()
              .mockImplementation(
                (event: string, listener: (...args: unknown[]) => void) => {
                  if (event === 'error') {
                    channel.__triggerChannelError = listener as (
                      err: Error,
                    ) => void;
                  } else if (event === 'close') {
                    channel.__triggerChannelClose = listener as () => void;
                  }
                },
              ),
          };
          const connection: ConnectionMock = {
            createChannel: jest.fn().mockResolvedValue(channel),
            close: jest.fn().mockResolvedValue(undefined),
            on: jest
              .fn()
              .mockImplementation(
                (event: string, listener: (...args: unknown[]) => void) => {
                  if (event === 'close') {
                    connection.__triggerClose = listener as () => void;
                  } else if (event === 'error') {
                    connection.__triggerError = listener as (
                      err: Error,
                    ) => void;
                  }
                },
              ),
          };
          connectionInstances.push({
            args: { url, opts },
            connection,
            channel,
          });
          return Promise.resolve(connection);
        },
      ),
  };
});

const lastConn = () => connectionInstances[connectionInstances.length - 1];

async function buildAdapter(env: Record<string, string>): Promise<{
  adapter: RabbitMQBrokerAdapter;
  metrics: BrokerMetrics;
  close: () => Promise<void>;
}> {
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

  const adapter = moduleRef.get(RabbitMQBrokerAdapter);
  const metrics = moduleRef.get(BrokerMetrics);
  return { adapter, metrics, close: () => moduleRef.close() };
}

describe('RabbitMQBrokerAdapter', () => {
  beforeEach(() => {
    connectionInstances.length = 0;
    mockState.connectFailuresRemaining = 0;
  });

  it('stays dormant when BROKER_TYPE !== "rabbitmq"', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'kafka',
      RABBITMQ_URL: 'amqp://admin:admin@localhost:5672',
    });

    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    expect(connectionInstances.length).toBe(0);
    await close();
  });

  it('boots and connects when BROKER_TYPE=rabbitmq', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      RABBITMQ_PREFETCH_COUNT: '50',
    });

    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    expect(connectionInstances.length).toBe(1);
    expect(lastConn().args.url).toBe('amqp://admin:admin@rabbit:5672');
    expect(lastConn().connection.createChannel).toHaveBeenCalledTimes(1);
    expect(lastConn().channel.prefetch).toHaveBeenCalledWith(50);
    expect(lastConn().connection.on).toHaveBeenCalledWith(
      'close',
      expect.any(Function),
    );
    expect(lastConn().connection.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
    await close();
  });

  it('passes vhost when RABBITMQ_VHOST is set', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      RABBITMQ_VHOST: '/tenant-a',
    });

    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    expect(lastConn().args.opts).toEqual({ vhost: '/tenant-a' });
    await close();
  });

  it('uses default prefetch (100) when not set', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
    });

    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    expect(lastConn().channel.prefetch).toHaveBeenCalledWith(100);
    await close();
  });

  it('rejects invalid prefetch values', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      RABBITMQ_PREFETCH_COUNT: 'not-a-number',
    });

    await expect(
      (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit(),
    ).rejects.toThrow(/RABBITMQ_PREFETCH_COUNT/);
    await close();
  });

  it('rejects missing RABBITMQ_URL', async () => {
    // Empty string overrides the .env fallback that NestJS ConfigService reads
    // from process.env when a key isn't present in the load callback.
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      RABBITMQ_URL: '',
    });

    await expect(
      (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit(),
    ).rejects.toThrow(/RABBITMQ_URL/);
    await close();
  });

  it('fails boot with a 30s message after the retry budget is exhausted', async () => {
    jest.useFakeTimers();
    try {
      mockState.connectFailuresRemaining = 6;

      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });

      const initPromise = (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      const expectation =
        expect(initPromise).rejects.toThrow(/30s retry budget/);
      await jest.advanceTimersByTimeAsync(30_000);
      await expectation;
      await close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers after transient connect failures within the 30s budget', async () => {
    jest.useFakeTimers();
    try {
      mockState.connectFailuresRemaining = 3;

      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });

      const initPromise = (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);
      await initPromise;

      expect(connectionInstances.length).toBe(1);
      await close();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('publish', () => {
    it('asserts topic exchange (idempotent) and publishes JSON Buffer with correlationId headers', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await adapter.publish('test-topic', { foo: 'bar' });
      await adapter.publish('test-topic', { foo: 'baz' });

      expect(lastConn().channel.assertExchange).toHaveBeenCalledTimes(1);
      expect(lastConn().channel.assertExchange).toHaveBeenCalledWith(
        'test-topic',
        'topic',
        { durable: true },
      );

      expect(lastConn().channel.publish).toHaveBeenCalledTimes(2);
      const firstCall = lastConn().channel.publish.mock.calls[0] as unknown[];
      expect(firstCall[0]).toBe('test-topic');
      expect(firstCall[1]).toBe('test-topic');
      expect((firstCall[2] as Buffer).toString('utf8')).toBe(
        JSON.stringify({ foo: 'bar' }),
      );
      const opts = firstCall[3] as {
        persistent: boolean;
        headers: Record<string, string>;
      };
      expect(opts.persistent).toBe(true);
      expect(opts.headers.correlationId).toEqual(expect.any(String));
      expect(opts.headers.messageId).toEqual(expect.any(String));
      expect(opts.headers['content-type']).toBe('application/json');
      await close();
    });

    it('provisionTopic declares the exchange + durable queue but does NOT bind it', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await adapter.provisionTopic('campaigns.pack');

      const ch = lastConn().channel;
      expect(ch.assertExchange).toHaveBeenCalledWith(
        'campaigns.pack',
        'topic',
        {
          durable: true,
        },
      );
      expect(ch.assertQueue).toHaveBeenCalledWith('campaigns.pack', {
        durable: true,
      });
      // Unbound on purpose: a bound default queue would accumulate copies.
      expect(ch.bindQueue).not.toHaveBeenCalled();
      await close();
    });

    it('throws when called before onModuleInit (dormant adapter)', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });
      await expect(adapter.publish('any', {})).rejects.toThrow(
        /while inactive/,
      );
      await close();
    });
  });

  describe('subscribe + ack + nack', () => {
    async function subscribeAndCapture<T = unknown>(
      env: Record<string, string>,
    ) {
      const { adapter, metrics, close } = await buildAdapter({
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        ...env,
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      const received: BrokerMessage<T>[] = [];
      await adapter.subscribe<T>('events-topic', (msg) => {
        received.push(msg);
        return Promise.resolve();
      });
      const channel = lastConn().channel;
      return { adapter, metrics, close, received, channel };
    }

    it('asserts durable queue, binds routing key, and starts consumer', async () => {
      const { close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'campaign-sender',
      });

      const ch = lastConn().channel;
      expect(ch.assertQueue).toHaveBeenCalledWith(
        'campaign-sender-events-topic',
        { durable: true },
      );
      expect(ch.bindQueue).toHaveBeenCalledWith(
        'campaign-sender-events-topic',
        'events-topic',
        'events-topic',
      );
      expect(ch.consume).toHaveBeenCalledWith(
        'campaign-sender-events-topic',
        expect.any(Function),
      );
      await close();
    });

    it('decodes payload + headers into BrokerMessage and forwards to handler', async () => {
      const { received, channel, close } = await subscribeAndCapture<{
        a: number;
      }>({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      channel.__triggerMessage!({
        content: Buffer.from(JSON.stringify({ a: 1 })),
        fields: { deliveryTag: 5, routingKey: 'events-topic' },
        properties: {
          headers: {
            correlationId: Buffer.from('corr-1'),
            messageId: Buffer.from('msg-1'),
          },
        },
      });

      await new Promise((r) => setImmediate(r));

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ a: 1 });
      expect(received[0].headers.correlationId).toBe('corr-1');
      expect(received[0].headers.messageId).toBe('msg-1');
      await close();
    });

    it('ack calls channel.ack with the original raw message', async () => {
      const { adapter, received, channel, close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      const raw = {
        content: Buffer.from(JSON.stringify({ k: 'v' })),
        fields: { deliveryTag: 7, routingKey: 'events-topic' },
        properties: { headers: { correlationId: 'c', messageId: 'm' } },
      };
      channel.__triggerMessage!(raw);
      await new Promise((r) => setImmediate(r));

      await adapter.ack(received[0]);

      expect(channel.ack).toHaveBeenCalledWith(raw);
      await close();
    });

    it('nack(requeue=true) calls channel.nack with allUpTo=false, requeue=true', async () => {
      const { adapter, received, channel, close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      const raw = {
        content: Buffer.from(JSON.stringify({})),
        fields: { deliveryTag: 8, routingKey: 'events-topic' },
        properties: { headers: { correlationId: 'c', messageId: 'm' } },
      };
      channel.__triggerMessage!(raw);
      await new Promise((r) => setImmediate(r));

      await adapter.nack(received[0], true);

      expect(channel.nack).toHaveBeenCalledWith(raw, false, true);
      await close();
    });

    it('nack(requeue=false) calls channel.nack with requeue=false and increments terminal_failure metric', async () => {
      const { adapter, metrics, received, channel, close } =
        await subscribeAndCapture({
          BROKER_TYPE: 'rabbitmq',
          RUN_MODE: 'event-process',
        });

      const raw = {
        content: Buffer.from(JSON.stringify({})),
        fields: { deliveryTag: 9, routingKey: 'events-topic' },
        properties: { headers: { correlationId: 'c', messageId: 'm' } },
      };
      channel.__triggerMessage!(raw);
      await new Promise((r) => setImmediate(r));

      const incSpy = jest.spyOn(metrics.terminalFailures, 'inc');
      await adapter.nack(received[0], false);

      expect(channel.nack).toHaveBeenCalledWith(raw, false, false);
      expect(incSpy).toHaveBeenCalledWith({
        broker: 'rabbitmq',
        topic: 'events-topic',
      });
      await close();
    });

    it('nack(msg) without second arg defaults to requeue=true', async () => {
      const { adapter, received, channel, close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      const raw = {
        content: Buffer.from(JSON.stringify({})),
        fields: { deliveryTag: 10, routingKey: 'events-topic' },
        properties: { headers: { correlationId: 'c', messageId: 'm' } },
      };
      channel.__triggerMessage!(raw);
      await new Promise((r) => setImmediate(r));

      await adapter.nack(received[0]);

      expect(channel.nack).toHaveBeenCalledWith(raw, false, true);
      await close();
    });

    it('rejects subscribing twice to the same topic', async () => {
      const { adapter, close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      await expect(
        adapter.subscribe('events-topic', () => Promise.resolve()),
      ).rejects.toThrow(/already has a consumer registered/);
      await close();
    });

    it('skips poison-pill messages with nack(requeue=false) and increments metric', async () => {
      const { metrics, channel, close } = await subscribeAndCapture({
        BROKER_TYPE: 'rabbitmq',
        RUN_MODE: 'event-process',
      });

      const incSpy = jest.spyOn(metrics.terminalFailures, 'inc');
      const raw = {
        content: Buffer.from('not-json{{{'),
        fields: { deliveryTag: 11, routingKey: 'events-topic' },
        properties: { headers: {} },
      };
      channel.__triggerMessage!(raw);
      await new Promise((r) => setImmediate(r));

      expect(channel.nack).toHaveBeenCalledWith(raw, false, false);
      expect(incSpy).toHaveBeenCalledWith({
        broker: 'rabbitmq',
        topic: 'events-topic',
      });
      await close();
    });
  });

  describe('onModuleDestroy', () => {
    it('cancels consumers, closes channel and connection gracefully', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('t1', () => Promise.resolve());

      await (
        adapter as unknown as { onModuleDestroy: () => Promise<void> }
      ).onModuleDestroy();

      const c = lastConn();
      expect(c.channel.cancel).toHaveBeenCalled();
      expect(c.channel.close).toHaveBeenCalled();
      expect(c.connection.close).toHaveBeenCalled();
      await close();
    });
  });

  describe('reconnect on connection close', () => {
    it('rebuilds connection + channel + consumers when connection drops while active', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('drop-topic', () => Promise.resolve());

      expect(connectionInstances.length).toBe(1);
      const firstConn = lastConn();

      // Simulate connection drop.
      firstConn.connection.__triggerClose!();
      // Allow the reconnect microtask + first setTimeout(500ms) to settle.
      jest.useFakeTimers();
      try {
        await jest.advanceTimersByTimeAsync(600);
      } finally {
        jest.useRealTimers();
      }
      // Drain pending microtasks.
      await new Promise((r) => setImmediate(r));

      expect(connectionInstances.length).toBeGreaterThanOrEqual(2);
      const newConn = lastConn();
      expect(newConn.channel.assertQueue).toHaveBeenCalledWith(
        'event-process-drop-topic',
        { durable: true },
      );
      expect(newConn.channel.consume).toHaveBeenCalled();
      await close();
    });

    it('does NOT reconnect when close fires after onModuleDestroy', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('shutdown-topic', () => Promise.resolve());
      const firstConn = lastConn();

      await (
        adapter as unknown as { onModuleDestroy: () => Promise<void> }
      ).onModuleDestroy();

      // After destroy, simulate the underlying close event firing late.
      firstConn.connection.__triggerClose!();
      await new Promise((r) => setImmediate(r));

      // No new connection instance should have been created.
      expect(connectionInstances.length).toBe(1);
      await close();
    });

    it('registers channel listeners on openConnection (error + close)', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      const ch = lastConn().channel;
      expect(ch.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(ch.on).toHaveBeenCalledWith('close', expect.any(Function));
      await close();
    });

    it('logs but does NOT reconnect when the channel emits a bare error event', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('err-topic', () => Promise.resolve());
      const firstConn = lastConn();

      expect(() =>
        firstConn.channel.__triggerChannelError!(
          new Error('PRECONDITION_FAILED - bogus ack'),
        ),
      ).not.toThrow();
      await new Promise((r) => setImmediate(r));

      // No new connection — channel error alone doesn't drive reconnect; the
      // subsequent 'close' event would.
      expect(connectionInstances.length).toBe(1);
      await close();
    });

    it('triggers a full reconnect when the channel closes unexpectedly while active', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('chan-drop-topic', () => Promise.resolve());
      const firstConn = lastConn();

      jest.useFakeTimers();
      try {
        firstConn.channel.__triggerChannelClose!();
        await jest.advanceTimersByTimeAsync(600);
      } finally {
        jest.useRealTimers();
      }
      await new Promise((r) => setImmediate(r));

      expect(connectionInstances.length).toBeGreaterThanOrEqual(2);
      const newConn = lastConn();
      expect(newConn.channel.assertQueue).toHaveBeenCalledWith(
        'event-process-chan-drop-topic',
        { durable: true },
      );
      await close();
    });

    it('does NOT reconnect when channel close fires after onModuleDestroy', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('chan-shutdown-topic', () => Promise.resolve());
      const firstConn = lastConn();

      await (
        adapter as unknown as { onModuleDestroy: () => Promise<void> }
      ).onModuleDestroy();

      firstConn.channel.__triggerChannelClose!();
      await new Promise((r) => setImmediate(r));

      expect(connectionInstances.length).toBe(1);
      await close();
    });

    it('cancels the background-reconnect chain when destroy fires during reconnect', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        RABBITMQ_URL: 'amqp://admin:admin@rabbit:5672',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('drop-topic', () => Promise.resolve());
      const firstConn = lastConn();

      jest.useFakeTimers();
      try {
        // Make every reconnect attempt fail so we drain the 5s budget and
        // schedule the background-reconnect chain.
        mockState.connectFailuresRemaining = 100;
        firstConn.connection.__triggerClose!();
        // Drain the in-budget reconnect loop (~5s of backoff sleeps).
        await jest.advanceTimersByTimeAsync(6_000);

        // At this point a background setTimeout is queued. Destroy must
        // clear `reconnecting` so the next firing returns early.
        await (
          adapter as unknown as { onModuleDestroy: () => Promise<void> }
        ).onModuleDestroy();
        const countBeforeFire = connectionInstances.length;

        // Drain several background intervals — none should produce a new
        // connection because reconnecting was cleared by destroy.
        mockState.connectFailuresRemaining = 0; // mock would succeed if attempted
        await jest.advanceTimersByTimeAsync(30_000);

        expect(connectionInstances.length).toBe(countBeforeFire);
      } finally {
        jest.useRealTimers();
      }
      await close();
    });
  });
});
