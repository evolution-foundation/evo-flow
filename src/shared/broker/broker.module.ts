import { Global, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  inject: [ConfigService],
  useFactory: (config: ConfigService): IMessageBroker => {
    const rawValue = config.get<string>('BROKER_TYPE');
    const validList = BROKER_TYPE_VALUES.join(', ');

    if (!rawValue) {
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
        return new KafkaBrokerAdapter();
      case BrokerType.RABBITMQ:
        return new RabbitMQBrokerAdapter();
      default: {
        const _exhaustive: never = rawValue as never;
        throw new BrokerConfigError(
          `BROKER_TYPE="${String(_exhaustive)}" has no adapter mapping. Update BrokerModule factory.`,
        );
      }
    }
  },
};

@Global()
@Module({
  providers: [brokerProvider],
  exports: [brokerProvider],
})
export class BrokerModule {}
