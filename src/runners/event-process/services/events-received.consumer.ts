import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  BrokerMessage,
  IMessageBroker,
  IMESSAGE_BROKER,
} from 'src/shared/broker/interfaces/message-broker.interface';
import { EVENTS_RECEIVED_TOPIC_PREFIX } from 'src/shared/broker/contracts/events-received.contract';
import { CorrelationContext } from 'src/shared/correlation/correlation.context';
import { EventProcessService } from './event-process.service';

/**
 * Subscribes to the whole `events.received.<platform>` topic family via the
 * broker's wildcard `subscribePattern` and runs each envelope through the
 * (stubbed) `EventProcessService` inside the correlation context, then acks.
 * Handler/ack failures nack with requeue so the message is re-delivered.
 */
@Injectable()
export class EventsReceivedConsumer implements OnModuleInit {
  private readonly logger = new CustomLoggerService(
    EventsReceivedConsumer.name,
  );

  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly correlation: CorrelationContext,
    private readonly service: EventProcessService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.broker.subscribePattern(EVENTS_RECEIVED_TOPIC_PREFIX, (msg) =>
      this.dispatch(msg),
    );
    this.logger.log('event-process.subscribed', {
      action: 'event-process.subscribed',
      prefix: EVENTS_RECEIVED_TOPIC_PREFIX,
    });
  }

  private async dispatch(msg: BrokerMessage): Promise<void> {
    const correlationId = this.correlation.resolveIncoming(
      msg.headers.correlationId,
    );
    await this.correlation.runWithCorrelationId(correlationId, async () => {
      try {
        await this.service.handle(msg.payload);
        await this.broker.ack(msg);
      } catch (err) {
        this.logger.error('event-process.consume.error', {
          action: 'event-process.consume.error',
          correlationId,
          error: (err as Error).message,
        });
        await this.broker.nack(msg, true);
      }
    });
  }
}
