import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  IMessageBroker,
  IMESSAGE_BROKER,
} from './interfaces/message-broker.interface';
import { BROKER_TYPE_VALUES, BrokerType } from './types/broker-type.enum';
import { BrokerConfigError } from './errors/broker-config.error';
import { KafkaBrokerAdapter } from './adapters/kafka-broker.adapter';
import { RabbitMQBrokerAdapter } from './adapters/rabbitmq-broker.adapter';

const brokerProvider: Provider = {
  provide: IMESSAGE_BROKER,
  inject: [ConfigService, KafkaBrokerAdapter, RabbitMQBrokerAdapter],
  useFactory: (
    config: ConfigService,
    kafka: KafkaBrokerAdapter,
    rabbitmq: RabbitMQBrokerAdapter,
  ): IMessageBroker => {
    const rawValue = config.get<string>('BROKER_TYPE');
    const validList = BROKER_TYPE_VALUES.join(', ');

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      throw new BrokerConfigError(
        `BROKER_TYPE is required but not set. Set BROKER_TYPE to one of: ${validList}.`,
      );
    }

    if (!BROKER_TYPE_VALUES.includes(rawValue as BrokerType)) {
      throw new BrokerConfigError(
        `BROKER_TYPE="${rawValue}" is not a recognized value. Set BROKER_TYPE to one of: ${validList}.`,
      );
    }

    switch (rawValue as BrokerType) {
      case BrokerType.KAFKA:
        return kafka;
      case BrokerType.RABBITMQ:
        return rabbitmq;
    }
  },
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [KafkaBrokerAdapter, RabbitMQBrokerAdapter, brokerProvider],
  exports: [brokerProvider],
})
export class BrokerModule {}
