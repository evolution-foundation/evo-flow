/* eslint-disable @typescript-eslint/no-unused-vars -- stub adapter; params are part of the IMessageBroker contract and become live in EVO-1198 */
import { Injectable } from '@nestjs/common';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';
import { BrokerNotImplementedError } from '../errors/broker-config.error';

// Stub adapter — concrete amqplib implementation lands in EVO-1198.
// Selected by BrokerModule when BROKER_TYPE=rabbitmq so the DI wiring is
// exercised today; methods throw until 1.4 replaces them.
@Injectable()
export class RabbitMQBrokerAdapter implements IMessageBroker {
  publish<T>(topic: string, _payload: T): Promise<void> {
    throw new BrokerNotImplementedError(
      `RabbitMQBrokerAdapter.publish(topic="${topic}") not implemented yet — see EVO-1198.`,
    );
  }

  subscribe<T>(
    topic: string,
    _handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void> {
    throw new BrokerNotImplementedError(
      `RabbitMQBrokerAdapter.subscribe(topic="${topic}") not implemented yet — see EVO-1198.`,
    );
  }

  ack(msg: BrokerMessage): Promise<void> {
    throw new BrokerNotImplementedError(
      `RabbitMQBrokerAdapter.ack(id="${msg.id}") not implemented yet — see EVO-1198.`,
    );
  }

  nack(msg: BrokerMessage, requeue?: boolean): Promise<void> {
    throw new BrokerNotImplementedError(
      `RabbitMQBrokerAdapter.nack(id="${msg.id}", requeue=${requeue ?? false}) not implemented yet — see EVO-1198.`,
    );
  }
}
