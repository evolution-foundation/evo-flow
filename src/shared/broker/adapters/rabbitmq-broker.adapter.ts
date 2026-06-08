import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { randomUUID } from 'crypto';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';
import { BrokerType } from '../types/broker-type.enum';
import { BrokerMetrics } from '../metrics/broker-metrics';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;
type AmqpMessage = NonNullable<
  Parameters<NonNullable<Parameters<AmqpChannel['consume']>[1]>>[0]
>;

const BROKER_LABEL = 'rabbitmq';
const DEFAULT_PREFETCH = 100;
const CONNECT_RETRY_BUDGET_MS = 30_000;
const CONNECT_RETRY_MAX_BACKOFF_MS = 15_000;
const RECONNECT_BUDGET_MS = 5_000;
const RECONNECT_BACKGROUND_INTERVAL_MS = 5_000;

type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SubscriptionState<T = unknown> {
  topic: string;
  queueName: string;
  consumerTag: string | null;
  handler: (msg: BrokerMessage<T>) => Promise<void>;
}

interface AmqpAckHandle {
  topic: string;
  raw: AmqpMessage;
}

@Injectable()
export class RabbitMQBrokerAdapter
  implements IMessageBroker, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(RabbitMQBrokerAdapter.name);

  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly declaredExchanges = new Set<string>();
  private readonly pendingAcks = new WeakMap<BrokerMessage, AmqpAckHandle>();
  private active = false;
  private reconnecting = false;
  private warnedAboutRunMode = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: BrokerMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const brokerType = this.config.get<string>('BROKER_TYPE');
    if (brokerType !== BrokerType.RABBITMQ) {
      return;
    }

    this.validateConfig();
    await this.connectWithBackoff();
    this.active = true;
    this.writeStructured('info', 'broker.boot', { broker: BROKER_LABEL });
  }

  private validateConfig(): void {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      throw new Error(
        'RABBITMQ_URL must be set (format: amqp://user:pass@host:port/vhost).',
      );
    }
    const prefetchRaw = this.config.get<string>('RABBITMQ_PREFETCH_COUNT');
    if (prefetchRaw !== undefined && prefetchRaw !== '') {
      const prefetch = parseInt(prefetchRaw, 10);
      if (Number.isNaN(prefetch) || prefetch <= 0) {
        throw new Error(
          `RABBITMQ_PREFETCH_COUNT="${prefetchRaw}" must be a positive integer.`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Always run cleanup. Without this, a destroy fired while we're in the
    // background-reconnect chain (active=false, connection=null, reconnecting=true)
    // would skip cleanup and leave the setTimeout chain alive, leaking the process.
    this.reconnecting = false;
    this.active = false;

    for (const [topic, sub] of this.subscriptions.entries()) {
      if (!sub.consumerTag) continue;
      try {
        await this.channel?.cancel(sub.consumerTag);
      } catch (err) {
        this.writeStructured('warn', 'broker.shutdown.consumer_failed', {
          broker: BROKER_LABEL,
          topic,
          error: (err as Error).message,
        });
      }
    }
    this.subscriptions.clear();

    try {
      await this.channel?.close();
    } catch (err) {
      this.writeStructured('warn', 'broker.shutdown.channel_failed', {
        broker: BROKER_LABEL,
        error: (err as Error).message,
      });
    }
    try {
      await this.connection?.close();
    } catch (err) {
      this.writeStructured('warn', 'broker.shutdown.connection_failed', {
        broker: BROKER_LABEL,
        error: (err as Error).message,
      });
    }

    this.connection = null;
    this.channel = null;
  }

  async publish<T>(topic: string, payload: T): Promise<void> {
    this.assertActive('publish');

    await this.ensureExchange(topic);

    const correlationId = randomUUID();
    const messageId = randomUUID();
    const content = Buffer.from(JSON.stringify(payload));

    this.channel!.publish(topic, topic, content, {
      persistent: true,
      contentType: 'application/json',
      messageId,
      correlationId,
      headers: {
        correlationId,
        messageId,
        'content-type': 'application/json',
      },
    });

    this.writeStructured('debug', 'broker.publish', {
      broker: BROKER_LABEL,
      topic,
      correlationId,
      messageId,
    });
  }

  async subscribe<T>(
    topic: string,
    handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void> {
    this.assertActive('subscribe');

    if (this.subscriptions.has(topic)) {
      throw new Error(
        `RabbitMQBrokerAdapter already has a consumer registered for topic "${topic}".`,
      );
    }

    const queueName = `${this.resolveRunMode(topic)}-${topic}`;
    const state: SubscriptionState<T> = {
      topic,
      queueName,
      consumerTag: null,
      handler,
    };
    this.subscriptions.set(topic, state as SubscriptionState);

    await this.attachConsumer(state);
    this.writeStructured('info', 'broker.subscribe', {
      broker: BROKER_LABEL,
      topic,
      queueName,
    });
  }

  async provisionTopic(topic: string): Promise<void> {
    this.assertActive('provisionTopic');
    await this.ensureExchange(topic);
    // Declare the durable queue but do NOT bind it. A bound, never-drained
    // default queue would accumulate a copy of every message — the real
    // consumer uses its own `${runMode}-${topic}` queue and binds it on
    // subscribe. Provisioning only guarantees the exchange + queue exist.
    await this.channel!.assertQueue(topic, { durable: true });
  }

  async ack(msg: BrokerMessage): Promise<void> {
    const handle = this.pendingAcks.get(msg);
    if (!handle) {
      throw new Error(
        `RabbitMQBrokerAdapter.ack called on unknown message id="${msg.id}". Was the message produced by this adapter's subscribe?`,
      );
    }
    if (!this.channel) {
      // Channel dropped after dispatch — broker will re-deliver on reconnect.
      this.pendingAcks.delete(msg);
      this.writeStructured('warn', 'broker.ack.no_channel', {
        broker: BROKER_LABEL,
        topic: handle.topic,
        correlationId: msg.headers.correlationId,
        messageId: msg.headers.messageId,
      });
      return Promise.resolve();
    }

    this.channel.ack(handle.raw);
    this.pendingAcks.delete(msg);
    this.writeStructured('debug', 'broker.ack', {
      broker: BROKER_LABEL,
      topic: handle.topic,
      correlationId: msg.headers.correlationId,
      messageId: msg.headers.messageId,
    });
    return Promise.resolve();
  }

  async nack(msg: BrokerMessage, requeue: boolean = true): Promise<void> {
    const handle = this.pendingAcks.get(msg);
    if (!handle) {
      throw new Error(
        `RabbitMQBrokerAdapter.nack called on unknown message id="${msg.id}". Was the message produced by this adapter's subscribe?`,
      );
    }
    if (!this.channel) {
      this.pendingAcks.delete(msg);
      this.writeStructured('warn', 'broker.nack.no_channel', {
        broker: BROKER_LABEL,
        topic: handle.topic,
        correlationId: msg.headers.correlationId,
        messageId: msg.headers.messageId,
      });
      return Promise.resolve();
    }

    this.channel.nack(handle.raw, false, requeue);
    this.pendingAcks.delete(msg);

    if (!requeue) {
      this.metrics.terminalFailures.inc({
        broker: BROKER_LABEL,
        topic: handle.topic,
      });
      this.writeStructured('info', 'broker.nack.terminal', {
        broker: BROKER_LABEL,
        topic: handle.topic,
        correlationId: msg.headers.correlationId,
        messageId: msg.headers.messageId,
      });
    } else {
      this.writeStructured('info', 'broker.nack.requeue', {
        broker: BROKER_LABEL,
        topic: handle.topic,
        correlationId: msg.headers.correlationId,
        messageId: msg.headers.messageId,
      });
    }
    return Promise.resolve();
  }

  private async attachConsumer<T>(state: SubscriptionState<T>): Promise<void> {
    await this.ensureExchange(state.topic);
    await this.channel!.assertQueue(state.queueName, { durable: true });
    await this.channel!.bindQueue(state.queueName, state.topic, state.topic);

    const { consumerTag } = await this.channel!.consume(
      state.queueName,
      (raw) => {
        if (raw === null) return;
        void this.dispatchMessage(raw, state);
      },
    );
    state.consumerTag = consumerTag;
  }

  private async dispatchMessage<T>(
    raw: AmqpMessage,
    state: SubscriptionState<T>,
  ): Promise<void> {
    if (raw === null) return;

    const headers = this.decodeHeaders(raw.properties.headers);
    let parsed: T;
    try {
      parsed = JSON.parse(raw.content.toString('utf8')) as T;
    } catch (err) {
      this.writeStructured('error', 'broker.consume.poison', {
        broker: BROKER_LABEL,
        topic: state.topic,
        deliveryTag: raw.fields.deliveryTag,
        correlationId: headers.correlationId,
        messageId: headers.messageId,
        error: (err as Error).message,
      });
      this.metrics.terminalFailures.inc({
        broker: BROKER_LABEL,
        topic: state.topic,
      });
      try {
        this.channel?.nack(raw, false, false);
      } catch {
        // Channel may be closed; broker will re-deliver after reconnect.
      }
      return;
    }

    const brokerMsg: BrokerMessage<T> = {
      id: `${state.topic}/${raw.fields.deliveryTag}`,
      payload: parsed,
      headers,
      raw,
    };
    this.pendingAcks.set(brokerMsg, { topic: state.topic, raw });

    this.writeStructured('debug', 'broker.consume', {
      broker: BROKER_LABEL,
      topic: state.topic,
      deliveryTag: raw.fields.deliveryTag,
      correlationId: headers.correlationId,
      messageId: headers.messageId,
    });

    try {
      await state.handler(brokerMsg);
    } catch (err) {
      // Handler did not ack/nack — leave unack'd; broker re-delivers on
      // consumer cancellation or after channel drop.
      this.writeStructured('error', 'broker.consume.handler_error', {
        broker: BROKER_LABEL,
        topic: state.topic,
        deliveryTag: raw.fields.deliveryTag,
        correlationId: headers.correlationId,
        messageId: headers.messageId,
        error: (err as Error).message,
      });
    }
  }

  private decodeHeaders(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (raw == null || typeof raw !== 'object') return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value == null) continue;
      if (Buffer.isBuffer(value)) {
        out[key] = value.toString('utf8');
        continue;
      }
      if (typeof value === 'string') {
        out[key] = value;
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value);
        continue;
      }
      out[key] = JSON.stringify(value);
    }
    return out;
  }

  private async ensureExchange(topic: string): Promise<void> {
    if (this.declaredExchanges.has(topic)) return;
    await this.channel!.assertExchange(topic, 'topic', { durable: true });
    this.declaredExchanges.add(topic);
  }

  private resolveRunMode(topic: string): string {
    const runMode = this.config.get<string>('RUN_MODE');
    if (runMode) return runMode;
    if (!this.warnedAboutRunMode) {
      this.writeStructured('warn', 'broker.subscribe.no_run_mode', {
        broker: BROKER_LABEL,
        topic,
        fallback: 'single',
        hint: 'Set RUN_MODE so consumer queues isolate per pipeline mode.',
      });
      this.warnedAboutRunMode = true;
    }
    return 'single';
  }

  private async connectWithBackoff(): Promise<void> {
    const startTime = Date.now();
    const deadline = startTime + CONNECT_RETRY_BUDGET_MS;
    let lastErr: Error | null = null;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        await this.openConnection();
        return;
      } catch (err) {
        lastErr = err as Error;
        this.writeStructured('warn', 'broker.connect.retry', {
          broker: BROKER_LABEL,
          attempt,
          elapsedMs: Date.now() - startTime,
          error: lastErr.message,
        });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `RabbitMQBrokerAdapter failed to connect within ${CONNECT_RETRY_BUDGET_MS / 1000}s retry budget (${attempt} attempts): ${lastErr.message}`,
        );
      }

      const exponential = 1000 * Math.pow(2, attempt - 1);
      const wait = Math.min(
        exponential,
        CONNECT_RETRY_MAX_BACKOFF_MS,
        remaining,
      );
      await this.sleep(wait);
    }
  }

  private async openConnection(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL')!;
    const vhost = this.config.get<string>('RABBITMQ_VHOST');
    const prefetchRaw = this.config.get<string>('RABBITMQ_PREFETCH_COUNT');
    const prefetch = prefetchRaw ? parseInt(prefetchRaw, 10) : DEFAULT_PREFETCH;

    const connectOpts = vhost ? { vhost } : undefined;
    this.connection = await amqplib.connect(url, connectOpts);
    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(prefetch);

    this.connection.on('close', (err?: Error) => {
      if (err) {
        this.writeStructured('warn', 'broker.connection.close_with_error', {
          broker: BROKER_LABEL,
          error: err.message,
        });
      }
      void this.handleConnectionClose();
    });
    this.connection.on('error', (err) => {
      this.writeStructured('error', 'broker.connection.error', {
        broker: BROKER_LABEL,
        error: (err as Error).message,
      });
    });
    this.channel.on('error', (err) => {
      // amqplib emits 'error' on the channel for protocol errors (invalid ack,
      // publish to a missing exchange, etc.). Without a listener Node crashes
      // with 'Unhandled error event'. The 'close' event right after drives
      // the actual reconnect.
      this.writeStructured('error', 'broker.channel.error', {
        broker: BROKER_LABEL,
        error: (err as Error).message,
      });
    });
    this.channel.on('close', () => {
      // Channel close with the connection still alive means broker/amqplib
      // killed only the channel; consumers would silently stop without a
      // reconnect. Active=false means we're in shutdown — nothing to do.
      if (!this.active) return;
      this.writeStructured('warn', 'broker.channel.closed_unexpected', {
        broker: BROKER_LABEL,
      });
      void this.handleConnectionClose();
    });
  }

  private async handleConnectionClose(): Promise<void> {
    if (!this.active) return;
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.active = false;

    this.writeStructured('warn', 'broker.connection.lost', {
      broker: BROKER_LABEL,
    });
    this.connection = null;
    this.channel = null;
    this.declaredExchanges.clear();

    const startTime = Date.now();
    const deadline = startTime + RECONNECT_BUDGET_MS;

    const tryReconnect = async (): Promise<boolean> => {
      try {
        await this.openConnection();
        for (const sub of this.subscriptions.values()) {
          sub.consumerTag = null;
          await this.attachConsumer(sub);
        }
        return true;
      } catch (err) {
        this.writeStructured('warn', 'broker.connection.retry', {
          broker: BROKER_LABEL,
          elapsedMs: Date.now() - startTime,
          error: (err as Error).message,
        });
        return false;
      }
    };

    let attempt = 0;
    let wait = 500;
    while (Date.now() < deadline) {
      attempt++;
      if (await tryReconnect()) {
        this.reconnecting = false;
        this.active = true;
        this.writeStructured('info', 'broker.connection.restored', {
          broker: BROKER_LABEL,
          attempts: attempt,
          elapsedMs: Date.now() - startTime,
        });
        return;
      }
      const remaining = deadline - Date.now();
      const sleepMs = Math.min(wait, remaining);
      if (sleepMs <= 0) break;
      await this.sleep(sleepMs);
      wait = Math.min(wait * 2, 2000);
    }

    // Per D5b option B: budget exceeded, keep trying in background
    // at a steady cadence. active stays false so publish callers fail fast.
    this.active = false;
    this.writeStructured('error', 'broker.connection.budget_exceeded', {
      broker: BROKER_LABEL,
      budgetMs: RECONNECT_BUDGET_MS,
      hint: 'Switching to background reconnect; publishers will fail until restored.',
    });
    this.scheduleBackgroundReconnect();
  }

  private scheduleBackgroundReconnect(): void {
    const attempt = async (): Promise<void> => {
      if (!this.reconnecting) return;
      try {
        await this.openConnection();
        for (const sub of this.subscriptions.values()) {
          sub.consumerTag = null;
          await this.attachConsumer(sub);
        }
        this.reconnecting = false;
        this.active = true;
        this.writeStructured('info', 'broker.connection.restored', {
          broker: BROKER_LABEL,
          source: 'background',
        });
      } catch (err) {
        this.writeStructured('warn', 'broker.connection.retry', {
          broker: BROKER_LABEL,
          source: 'background',
          error: (err as Error).message,
        });
        setTimeout(() => void attempt(), RECONNECT_BACKGROUND_INTERVAL_MS);
      }
    };
    setTimeout(() => void attempt(), RECONNECT_BACKGROUND_INTERVAL_MS);
  }

  private assertActive(op: string): void {
    if (!this.active) {
      throw new Error(
        `RabbitMQBrokerAdapter.${op} called while inactive. Set BROKER_TYPE=rabbitmq and ensure onModuleInit completed; if reconnecting, retry later.`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private writeStructured(
    level: StructuredLogLevel,
    action: string,
    ctx: Record<string, unknown>,
  ): void {
    const file = this.logger.getFileLogger();
    const payload = { action, ...ctx };
    switch (level) {
      case 'debug':
        file.debug(action, payload);
        return;
      case 'info':
        this.logger.log(action, payload);
        return;
      case 'warn':
        this.logger.warn(action, payload);
        file.warn(action, payload);
        return;
      case 'error':
        this.logger.error(action, payload);
        file.error(action, payload);
        return;
    }
  }
}
