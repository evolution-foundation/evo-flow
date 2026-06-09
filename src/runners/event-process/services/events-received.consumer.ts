import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  BrokerMessage,
  IMessageBroker,
  IMESSAGE_BROKER,
} from 'src/shared/broker/interfaces/message-broker.interface';
import { EVENTS_RECEIVED_TOPIC_PREFIX } from 'src/shared/broker/contracts/events-received.contract';
import { CorrelationContext } from 'src/shared/correlation/correlation.context';
import { processWithAckPolicy } from 'src/shared/broker/consumer/process-with-ack-policy';
import { EventProcessService } from './event-process.service';

/**
 * Subscribes to the whole `events.received.<platform>` topic family via the
 * broker's wildcard `subscribePattern` and runs each envelope through the
 * (stubbed) `EventProcessService` inside the correlation context, then acks.
 *
 * Subscription happens in `onApplicationBootstrap` (not `onModuleInit`) so the
 * broker adapter has finished its own `onModuleInit` (active=true) first —
 * otherwise the hook order between this consumer and the adapter is undefined.
 *
 * Failure handling: a permanent `InvalidEnvelopeError` is dropped (terminal
 * nack) so a poison message cannot redeliver forever; any other (transient)
 * error requeues for redelivery.
 */
@Injectable()
export class EventsReceivedConsumer implements OnApplicationBootstrap {
  private readonly logger = new CustomLoggerService(
    EventsReceivedConsumer.name,
  );

  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly correlation: CorrelationContext,
    private readonly service: EventProcessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
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
    await this.correlation.runWithCorrelationId(correlationId, () =>
      processWithAckPolicy(
        msg,
        this.broker,
        { logger: this.logger, context: 'EventsReceivedConsumer' },
        () => this.service.handle(msg.payload),
      ),
    );
  }
}
