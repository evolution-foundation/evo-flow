import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BrokerModule } from './broker.module';
import {
  BrokerMessage,
  IMessageBroker,
  IMESSAGE_BROKER,
} from './interfaces/message-broker.interface';
import { KafkaBrokerAdapter } from './adapters/kafka-broker.adapter';
import { RabbitMQBrokerAdapter } from './adapters/rabbitmq-broker.adapter';
import { BrokerConfigError } from './errors/broker-config.error';
import { BrokerNotImplementedError } from './errors/broker-not-implemented.error';

function compileBrokerModule(brokerType: string | undefined) {
  const env: Record<string, string> = {};
  if (brokerType !== undefined) {
    env.BROKER_TYPE = brokerType;
  }
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
      BrokerModule,
    ],
  }).compile();
}

describe('BrokerModule', () => {
  const originalBrokerType = process.env.BROKER_TYPE;

  beforeEach(() => {
    delete process.env.BROKER_TYPE;
  });

  afterAll(() => {
    if (originalBrokerType === undefined) {
      delete process.env.BROKER_TYPE;
    } else {
      process.env.BROKER_TYPE = originalBrokerType;
    }
  });

  it('resolves IMessageBroker to KafkaBrokerAdapter when BROKER_TYPE=kafka', async () => {
    const moduleRef = await compileBrokerModule('kafka');
    const broker = moduleRef.get<IMessageBroker>(IMESSAGE_BROKER);

    expect(broker).toBeInstanceOf(KafkaBrokerAdapter);

    await moduleRef.close();
  });

  it('resolves IMessageBroker to RabbitMQBrokerAdapter when BROKER_TYPE=rabbitmq', async () => {
    const moduleRef = await compileBrokerModule('rabbitmq');
    const broker = moduleRef.get<IMessageBroker>(IMESSAGE_BROKER);

    expect(broker).toBeInstanceOf(RabbitMQBrokerAdapter);

    await moduleRef.close();
  });

  it('fails boot with a descriptive error when BROKER_TYPE is unset', async () => {
    await expect(compileBrokerModule(undefined)).rejects.toThrow(
      BrokerConfigError,
    );
    await expect(compileBrokerModule(undefined)).rejects.toThrow(
      /BROKER_TYPE is required/,
    );
    await expect(compileBrokerModule(undefined)).rejects.toThrow(
      /kafka, rabbitmq/,
    );
  });

  it('fails boot with a descriptive error when BROKER_TYPE is empty', async () => {
    await expect(compileBrokerModule('')).rejects.toThrow(BrokerConfigError);
    await expect(compileBrokerModule('')).rejects.toThrow(/kafka, rabbitmq/);
  });

  it('fails boot with a descriptive error when BROKER_TYPE is invalid', async () => {
    await expect(compileBrokerModule('sqs')).rejects.toThrow(BrokerConfigError);
    await expect(compileBrokerModule('sqs')).rejects.toThrow(
      /BROKER_TYPE="sqs"/,
    );
    await expect(compileBrokerModule('sqs')).rejects.toThrow(/kafka, rabbitmq/);
  });

  it('rejects mixed-case BROKER_TYPE values (strict lowercase)', async () => {
    await expect(compileBrokerModule('Kafka')).rejects.toThrow(
      BrokerConfigError,
    );
  });

  describe('stub adapter methods', () => {
    const dummyMsg: BrokerMessage = {
      id: 'm-1',
      payload: null,
      headers: {},
      raw: null,
    };
    const noopHandler = () => Promise.resolve();

    it.each([
      ['kafka', KafkaBrokerAdapter],
      ['rabbitmq', RabbitMQBrokerAdapter],
    ])(
      '%s adapter methods reject with BrokerNotImplementedError (no sync throws)',
      async (_label, AdapterCtor) => {
        const adapter = new AdapterCtor();

        await expect(adapter.publish('topic-x', { a: 1 })).rejects.toThrow(
          BrokerNotImplementedError,
        );
        await expect(adapter.subscribe('topic-x', noopHandler)).rejects.toThrow(
          BrokerNotImplementedError,
        );
        await expect(adapter.ack(dummyMsg)).rejects.toThrow(
          BrokerNotImplementedError,
        );
        await expect(adapter.nack(dummyMsg, true)).rejects.toThrow(
          BrokerNotImplementedError,
        );
      },
    );
  });
});
