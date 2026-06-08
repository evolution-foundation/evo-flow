import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { KafkaBrokerAdapter } from './kafka-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';

type ProducerMock = {
  connect: jest.Mock;
  disconnect: jest.Mock;
  send: jest.Mock;
};
type AdminMock = {
  connect: jest.Mock;
  disconnect: jest.Mock;
  createTopics: jest.Mock;
};
type ConsumerMock = {
  connect: jest.Mock;
  disconnect: jest.Mock;
  subscribe: jest.Mock;
  run: jest.Mock;
  commitOffsets: jest.Mock;
  seek: jest.Mock;
  on: jest.Mock;
  events: { CRASH: string };
  __triggerMessage?: (payload: {
    topic: string;
    partition: number;
    message: {
      offset: string;
      value: Buffer | null;
      headers?: Record<string, Buffer | string | null>;
    };
  }) => Promise<void>;
  __triggerCrash?: (payload: {
    payload: { error?: { message: string }; restart?: boolean };
  }) => void;
};
type KafkaCtorArgs = {
  clientId?: string;
  brokers?: string[];
  ssl?: boolean;
  sasl?: unknown;
};

type ProducerSendCall = {
  topic: string;
  messages: Array<{
    value: string;
    headers: Record<string, string>;
  }>;
};

type CreateTopicsCall = {
  topics: Array<{
    topic: string;
    numPartitions: number;
    replicationFactor: number;
  }>;
  waitForLeaders: boolean;
};

const mockState: {
  connectFailuresRemaining: number;
} = {
  connectFailuresRemaining: 0,
};

const kafkaInstances: Array<{
  args: KafkaCtorArgs;
  producer: ProducerMock;
  admin: AdminMock;
  consumers: ConsumerMock[];
  consumerGroupIds: string[];
}> = [];

jest.mock('kafkajs', () => {
  return {
    Kafka: jest.fn().mockImplementation((args: KafkaCtorArgs) => {
      const producer: ProducerMock = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
      };
      const admin: AdminMock = {
        connect: jest.fn().mockImplementation(() => {
          if (mockState.connectFailuresRemaining > 0) {
            mockState.connectFailuresRemaining--;
            return Promise.reject(new Error('mocked connect failure'));
          }
          return Promise.resolve();
        }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        createTopics: jest.fn().mockResolvedValue(undefined),
      };
      const consumers: ConsumerMock[] = [];
      const consumerGroupIds: string[] = [];
      const entry = { args, producer, admin, consumers, consumerGroupIds };
      kafkaInstances.push(entry);
      return {
        producer: jest.fn().mockReturnValue(producer),
        admin: jest.fn().mockReturnValue(admin),
        consumer: jest
          .fn()
          .mockImplementation(({ groupId }: { groupId: string }) => {
            const c: ConsumerMock = {
              connect: jest.fn().mockResolvedValue(undefined),
              disconnect: jest.fn().mockResolvedValue(undefined),
              subscribe: jest.fn().mockResolvedValue(undefined),
              run: jest
                .fn()
                .mockImplementation(
                  ({
                    eachMessage,
                  }: {
                    eachMessage: ConsumerMock['__triggerMessage'];
                  }) => {
                    c.__triggerMessage = eachMessage;
                    return Promise.resolve();
                  },
                ),
              commitOffsets: jest.fn().mockResolvedValue(undefined),
              seek: jest.fn(),
              events: { CRASH: 'consumer.crash' },
              on: jest
                .fn()
                .mockImplementation(
                  (
                    eventName: string,
                    listener: ConsumerMock['__triggerCrash'],
                  ) => {
                    if (eventName === 'consumer.crash') {
                      c.__triggerCrash = listener;
                    }
                  },
                ),
            };
            consumers.push(c);
            consumerGroupIds.push(groupId);
            return c;
          }),
      };
    }),
  };
});

const lastKafka = () => kafkaInstances[kafkaInstances.length - 1];

async function buildAdapter(env: Record<string, string>): Promise<{
  adapter: KafkaBrokerAdapter;
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
    providers: [BrokerMetrics, KafkaBrokerAdapter],
  }).compile();

  const adapter = moduleRef.get(KafkaBrokerAdapter);
  const metrics = moduleRef.get(BrokerMetrics);
  return {
    adapter,
    metrics,
    close: () => moduleRef.close(),
  };
}

describe('KafkaBrokerAdapter', () => {
  beforeEach(() => {
    kafkaInstances.length = 0;
    mockState.connectFailuresRemaining = 0;
  });

  it('stays dormant when BROKER_TYPE !== "kafka"', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'rabbitmq',
      KAFKA_BROKERS: 'localhost:9092',
    });

    await (
      adapter as unknown as IMessageBroker & {
        onModuleInit: () => Promise<void>;
      }
    ).onModuleInit();

    expect(kafkaInstances.length).toBe(0);
    await close();
  });

  it('boots and connects when BROKER_TYPE=kafka', async () => {
    const { adapter, close } = await buildAdapter({
      BROKER_TYPE: 'kafka',
      KAFKA_BROKERS: 'broker-a:9092,broker-b:9092',
      KAFKA_SSL_ENABLED: 'false',
    });

    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();

    expect(kafkaInstances.length).toBe(1);
    expect(lastKafka().args.brokers).toEqual([
      'broker-a:9092',
      'broker-b:9092',
    ]);
    expect(lastKafka().args.ssl).toBe(false);
    expect(lastKafka().admin.connect).toHaveBeenCalledTimes(1);
    expect(lastKafka().producer.connect).toHaveBeenCalledTimes(1);
    await close();
  });

  it('fails boot with a 30s message after the retry budget is exhausted', async () => {
    jest.useFakeTimers();
    try {
      // 6 attempts × always fail → exhaust budget.
      mockState.connectFailuresRemaining = 6;

      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });

      const initPromise = (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      const expectation =
        expect(initPromise).rejects.toThrow(/30s retry budget/);

      // Drain the 30s retry budget (1s + 2s + 4s + 8s + 15s = 30s of waits).
      await jest.advanceTimersByTimeAsync(30_000);

      await expectation;
      expect(lastKafka().admin.connect).toHaveBeenCalledTimes(6);
      await close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers after transient connect failures within the 30s budget', async () => {
    jest.useFakeTimers();
    try {
      mockState.connectFailuresRemaining = 3; // 3 fails then succeed on attempt 4

      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });

      const initPromise = (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await jest.advanceTimersByTimeAsync(30_000);
      await initPromise;

      expect(lastKafka().admin.connect).toHaveBeenCalledTimes(4);
      expect(lastKafka().producer.connect).toHaveBeenCalledTimes(1);
      await close();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('publish', () => {
    it('sends JSON payload with correlationId and messageId headers', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await adapter.publish('test-topic', { foo: 'bar' });

      const send = (
        lastKafka().producer.send.mock.calls[0] as unknown[]
      )[0] as ProducerSendCall;
      expect(send.topic).toBe('test-topic');
      expect(send.messages).toHaveLength(1);
      expect(send.messages[0].value).toBe(JSON.stringify({ foo: 'bar' }));
      expect(send.messages[0].headers.correlationId).toEqual(
        expect.any(String),
      );
      expect(send.messages[0].headers.messageId).toEqual(expect.any(String));
      expect(send.messages[0].headers['content-type']).toBe('application/json');
      await close();
    });

    it('throws when called before onModuleInit (adapter dormant)', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'rabbitmq',
        KAFKA_BROKERS: 'localhost:9092',
      });
      // No onModuleInit — adapter never becomes active.
      await expect(adapter.publish('any', {})).rejects.toThrow(
        /before adapter became active/,
      );
      await close();
    });

    it('ensures topic exists (idempotent) on first publish, skips admin call on subsequent publishes', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await adapter.publish('publish-only-topic', { x: 1 });
      await adapter.publish('publish-only-topic', { x: 2 });
      await adapter.publish('publish-only-topic', { x: 3 });

      expect(lastKafka().admin.createTopics).toHaveBeenCalledTimes(1);
      const call = (
        lastKafka().admin.createTopics.mock.calls[0] as unknown[]
      )[0] as CreateTopicsCall;
      expect(call.topics[0].topic).toBe('publish-only-topic');
      expect(lastKafka().producer.send).toHaveBeenCalledTimes(3);
      await close();
    });

    it('provisionTopic creates the topic via admin.createTopics', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      await adapter.provisionTopic('campaigns.pack');

      expect(lastKafka().admin.createTopics).toHaveBeenCalledTimes(1);
      const call = (
        lastKafka().admin.createTopics.mock.calls[0] as unknown[]
      )[0] as CreateTopicsCall;
      expect(call.topics[0].topic).toBe('campaigns.pack');
      await close();
    });

    it('treats "topic already exists" as success and caches it', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();

      lastKafka().admin.createTopics.mockRejectedValueOnce(
        new Error('Topic with this name already exists'),
      );

      await expect(
        adapter.publish('shared-topic', { a: 1 }),
      ).resolves.toBeUndefined();
      // Second publish must NOT retry createTopics (cached as ensured).
      await adapter.publish('shared-topic', { a: 2 });
      expect(lastKafka().admin.createTopics).toHaveBeenCalledTimes(1);
      await close();
    });
  });

  describe('subscribe + ack + nack', () => {
    async function subscribeAndCapture<T = unknown>(
      env: Record<string, string>,
    ) {
      const { adapter, metrics, close } = await buildAdapter({
        KAFKA_BROKERS: 'localhost:9092',
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
      const consumer = lastKafka().consumers[0];
      return { adapter, metrics, close, received, consumer };
    }

    it('creates consumer with groupId = `${RUN_MODE}-${topic}` and partitions=12', async () => {
      const { close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'campaign-sender',
      });

      expect(lastKafka().consumerGroupIds).toEqual([
        'campaign-sender-events-topic',
      ]);
      const createTopicsCall = (
        lastKafka().admin.createTopics.mock.calls[0] as unknown[]
      )[0] as CreateTopicsCall;
      expect(createTopicsCall.topics[0].numPartitions).toBe(12);
      expect(createTopicsCall.waitForLeaders).toBe(true);
      await close();
    });

    it('decodes message headers + payload into BrokerMessage and forwards to handler', async () => {
      const { received, consumer, close } = await subscribeAndCapture<{
        a: number;
      }>({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 3,
        message: {
          offset: '42',
          value: Buffer.from(JSON.stringify({ a: 1 })),
          headers: {
            correlationId: Buffer.from('corr-1'),
            messageId: Buffer.from('msg-1'),
          },
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ a: 1 });
      expect(received[0].headers.correlationId).toBe('corr-1');
      expect(received[0].headers.messageId).toBe('msg-1');
      await close();
    });

    it('ack commits offset+1 on the consumer', async () => {
      const { adapter, received, consumer, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 2,
        message: {
          offset: '100',
          value: Buffer.from(JSON.stringify({ k: 'v' })),
          headers: { correlationId: 'cid', messageId: 'mid' },
        },
      });

      await adapter.ack(received[0]);

      expect(consumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'events-topic', partition: 2, offset: '101' },
      ]);
      await close();
    });

    it('nack(requeue=true) does NOT commit and seeks back to the original offset', async () => {
      const { adapter, received, consumer, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 1,
        message: {
          offset: '7',
          value: Buffer.from(JSON.stringify({})),
          headers: { correlationId: 'c', messageId: 'm' },
        },
      });

      await adapter.nack(received[0], true);

      expect(consumer.commitOffsets).not.toHaveBeenCalled();
      expect(consumer.seek).toHaveBeenCalledWith({
        topic: 'events-topic',
        partition: 1,
        offset: '7',
      });
      await close();
    });

    it('nack(msg) without second argument defaults to requeue=true', async () => {
      const { adapter, received, consumer, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 4,
        message: {
          offset: '11',
          value: Buffer.from(JSON.stringify({})),
          headers: { correlationId: 'c', messageId: 'm' },
        },
      });

      // No requeue argument → must behave like requeue=true.
      await adapter.nack(received[0]);

      expect(consumer.commitOffsets).not.toHaveBeenCalled();
      expect(consumer.seek).toHaveBeenCalledWith({
        topic: 'events-topic',
        partition: 4,
        offset: '11',
      });
      await close();
    });

    it('nack(requeue=false) commits offset+1 and increments terminal_failure metric', async () => {
      const { adapter, metrics, received, consumer, close } =
        await subscribeAndCapture({
          BROKER_TYPE: 'kafka',
          RUN_MODE: 'event-process',
        });

      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 0,
        message: {
          offset: '99',
          value: Buffer.from(JSON.stringify({})),
          headers: { correlationId: 'c', messageId: 'm' },
        },
      });

      const incSpy = jest.spyOn(metrics.terminalFailures, 'inc');
      await adapter.nack(received[0], false);

      expect(consumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'events-topic', partition: 0, offset: '100' },
      ]);
      expect(incSpy).toHaveBeenCalledWith({
        broker: 'kafka',
        topic: 'events-topic',
      });
      await close();
    });

    it('rejects subscribing twice to the same topic', async () => {
      const { adapter, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      await expect(
        adapter.subscribe('events-topic', () => Promise.resolve()),
      ).rejects.toThrow(/already has a consumer registered/);
      await close();
    });

    it('skips poison-pill messages by committing past them and incrementing metric', async () => {
      const { metrics, consumer, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      const incSpy = jest.spyOn(metrics.terminalFailures, 'inc');
      await consumer.__triggerMessage!({
        topic: 'events-topic',
        partition: 0,
        message: {
          offset: '5',
          value: Buffer.from('not-json{{{'),
          headers: {},
        },
      });

      expect(consumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'events-topic', partition: 0, offset: '6' },
      ]);
      expect(incSpy).toHaveBeenCalledWith({
        broker: 'kafka',
        topic: 'events-topic',
      });
      await close();
    });

    it('registers a consumer.crash handler that surfaces the event to logs', async () => {
      const { consumer, close } = await subscribeAndCapture({
        BROKER_TYPE: 'kafka',
        RUN_MODE: 'event-process',
      });

      expect(consumer.on).toHaveBeenCalledWith(
        'consumer.crash',
        expect.any(Function),
      );
      expect(consumer.__triggerCrash).toBeDefined();

      // Trigger crash event — must not throw, must be observable.
      expect(() =>
        consumer.__triggerCrash!({
          payload: {
            error: { message: 'broker disconnected' },
            restart: false,
          },
        }),
      ).not.toThrow();
      await close();
    });
  });

  describe('onModuleDestroy', () => {
    it('disconnects all consumers, producer and admin gracefully', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
        RUN_MODE: 'event-process',
      });
      await (
        adapter as unknown as { onModuleInit: () => Promise<void> }
      ).onModuleInit();
      await adapter.subscribe('t1', () => Promise.resolve());

      await (
        adapter as unknown as { onModuleDestroy: () => Promise<void> }
      ).onModuleDestroy();

      const k = lastKafka();
      expect(k.consumers[0].disconnect).toHaveBeenCalled();
      expect(k.producer.disconnect).toHaveBeenCalled();
      expect(k.admin.disconnect).toHaveBeenCalled();
      await close();
    });
  });

  describe('SASL config', () => {
    it('rejects unsupported mechanism', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
        KAFKA_SASL_MECHANISM: 'gssapi',
        KAFKA_SASL_USERNAME: 'u',
        KAFKA_SASL_PASSWORD: 'p',
      });

      await expect(
        (
          adapter as unknown as { onModuleInit: () => Promise<void> }
        ).onModuleInit(),
      ).rejects.toThrow(/KAFKA_SASL_MECHANISM/);
      await close();
    });

    it('rejects partial SASL config (mechanism without credentials)', async () => {
      const { adapter, close } = await buildAdapter({
        BROKER_TYPE: 'kafka',
        KAFKA_BROKERS: 'localhost:9092',
        KAFKA_SASL_MECHANISM: 'plain',
      });

      await expect(
        (
          adapter as unknown as { onModuleInit: () => Promise<void> }
        ).onModuleInit(),
      ).rejects.toThrow(/KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD/);
      await close();
    });
  });
});
