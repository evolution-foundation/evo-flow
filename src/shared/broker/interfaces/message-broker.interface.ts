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
  ack(msg: BrokerMessage): Promise<void>;
  nack(msg: BrokerMessage, requeue?: boolean): Promise<void>;
}

export const IMESSAGE_BROKER: unique symbol = Symbol('IMessageBroker');
