/**
 * Deploy-time topic provisioning (EVO-1200 / story 1.7).
 *
 * Reads BROKER_TYPE, boots a minimal Nest context with the real BrokerModule,
 * and idempotently provisions the 7 canonical pipeline topics through the
 * active adapter (Kafka topics / RabbitMQ exchanges + default queues). Run on
 * the first deploy of evo-flow to a fresh cluster, before any pipeline mode
 * starts. Safe to run repeatedly.
 *
 * Usage:
 *   BROKER_TYPE=kafka    npm run broker:provision-topics
 *   BROKER_TYPE=rabbitmq npm run broker:provision-topics
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { BrokerModule } from '../src/shared/broker/broker.module';
import {
  IMessageBroker,
  IMESSAGE_BROKER,
} from '../src/shared/broker/interfaces/message-broker.interface';
import { ALL_CONTRACT_TOPIC_NAMES } from '../src/shared/broker/contracts/broker-topics';
import { EVENTS_RECEIVED_TOPIC_PREFIX } from '../src/shared/broker/contracts/events-received.contract';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), BrokerModule],
})
class ProvisionModule {}

// The 6 concrete contract topics + the events.received template root (its
// per-platform instances are created dynamically by the event-receiver).
const TOPICS: readonly string[] = [
  ...ALL_CONTRACT_TOPIC_NAMES,
  EVENTS_RECEIVED_TOPIC_PREFIX,
];

async function main(): Promise<void> {
  const brokerType = process.env.BROKER_TYPE;
  if (!brokerType) {
    console.error('BROKER_TYPE is required (kafka | rabbitmq).');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(ProvisionModule, {
    logger: ['error', 'warn'],
  });
  const broker = app.get<IMessageBroker>(IMESSAGE_BROKER);

  try {
    for (const topic of TOPICS) {
      await broker.provisionTopic(topic);
      console.log(`provisioned ${topic} (${brokerType})`);
    }
    console.log(`Provisioned ${TOPICS.length} topics on ${brokerType}.`);
  } finally {
    // Bound the graceful shutdown: the broker client's reconnect timers can
    // delay app.close() indefinitely, and this is a one-shot script.
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

main()
  // Force exit: the broker client keeps the event loop alive even after
  // app.close(), so a long-running script would otherwise never return.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to provision topics:', err);
    process.exit(1);
  });
