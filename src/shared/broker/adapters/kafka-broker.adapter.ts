/* eslint-disable @typescript-eslint/no-unused-vars -- stub adapter; params are part of the IMessageBroker contract and become live in EVO-1197 */
import { Injectable } from '@nestjs/common';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';
import { BrokerNotImplementedError } from '../errors/broker-config.error';

// Stub adapter — concrete kafkajs implementation lands in EVO-1197.
// Selected by BrokerModule when BROKER_TYPE=kafka so the DI wiring is
// exercised today; methods throw until 1.3 replaces them.
@Injectable()
export class KafkaBrokerAdapter implements IMessageBroker {
  publish<T>(topic: string, _payload: T): Promise<void> {
    throw new BrokerNotImplementedError(
      `KafkaBrokerAdapter.publish(topic="${topic}") not implemented yet — see EVO-1197.`,
    );
  }

  subscribe<T>(
    topic: string,
    _handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void> {
    throw new BrokerNotImplementedError(
      `KafkaBrokerAdapter.subscribe(topic="${topic}") not implemented yet — see EVO-1197.`,
    );
  }

  ack(msg: BrokerMessage): Promise<void> {
    throw new BrokerNotImplementedError(
      `KafkaBrokerAdapter.ack(id="${msg.id}") not implemented yet — see EVO-1197.`,
    );
  }

  nack(msg: BrokerMessage, requeue?: boolean): Promise<void> {
    throw new BrokerNotImplementedError(
      `KafkaBrokerAdapter.nack(id="${msg.id}", requeue=${requeue ?? false}) not implemented yet — see EVO-1197.`,
    );
  }
}
