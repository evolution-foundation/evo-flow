/**
 * Broker-agnostic transport abstraction for the distributed pipeline (EVO-1196).
 * Concrete adapters (kafkajs, amqplib) live in `../adapters/` and are selected
 * at boot by `BrokerModule` based on the `BROKER_TYPE` env var.
 */

export interface BrokerMessage<T = unknown> {
  id: string;
  payload: T;
  headers: Record<string, string>;
  raw: unknown;
}

export interface IMessageBroker {
  publish<T>(topic: string, payload: T): Promise<void>;
  subscribe<T>(
    topic: string,
    handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void>;
  /**
   * Subscribe to every topic under a dot-delimited `prefix` (e.g.
   * `events.received` → all `events.received.<segment>` topics). Each adapter
   * maps the prefix to its native wildcard: Kafka to a RegExp consumer
   * subscription, RabbitMQ to a `<prefix>.#` binding on a shared `<prefix>`
   * topic exchange (see `EVENTS_RECEIVED_*` in contracts/broker-topics.ts).
   */
  subscribePattern<T>(
    prefix: string,
    handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void>;
  ack(msg: BrokerMessage): Promise<void>;
  nack(msg: BrokerMessage, requeue?: boolean): Promise<void>;
  /**
   * Idempotently create a topic's broker-side topology (Kafka topic; RabbitMQ
   * exchange + default durable queue + binding) ahead of any publish/subscribe,
   * for explicit deploy-time provisioning (EVO-1200). Safe to call repeatedly.
   */
  provisionTopic(topic: string): Promise<void>;
}

export const IMESSAGE_BROKER: unique symbol = Symbol('IMessageBroker');
