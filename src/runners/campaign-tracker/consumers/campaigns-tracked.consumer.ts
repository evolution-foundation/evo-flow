import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
  BrokerMessage,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_TRACKED_TOPIC,
  isCampaignsTrackedContract,
  type CampaignsTrackedContract,
} from '../../../shared/broker/contracts/campaigns-tracked.contract';
import { CorrelationContext } from '../../../shared/correlation/correlation.context';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { CampaignTrackerService } from '../services/campaign-tracker.service';
import { processWithAckPolicy } from '../../../shared/broker/consumer/process-with-ack-policy';

const LOG_CONTEXT = 'CampaignsTrackedConsumer';

/**
 * Broker consumer for `campaigns.tracked` (story 4.6 / EVO-1220). Subscribes on
 * boot and routes each page report to `CampaignTrackerService`, wrapping
 * processing in the payload's `correlationId` so every downstream log carries
 * it. The consumer group is named per RUN_MODE by the broker adapter, so
 * multiple tracker replicas share the topic's partitions.
 *
 * Ack/nack is delegated to the shared `processWithAckPolicy`: success → ack,
 * `TerminalError` → nack(requeue=false), any other error → nack(requeue=true).
 * A structurally invalid payload is dropped up-front (no correlationId to bind).
 */
@Injectable()
export class CampaignsTrackedConsumer implements OnModuleInit {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly tracker: CampaignTrackerService,
    private readonly correlation: CorrelationContext,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.broker.subscribe<CampaignsTrackedContract>(
      CAMPAIGNS_TRACKED_TOPIC,
      (msg) => this.handle(msg),
    );
    this.logger.log(`Subscribed to ${CAMPAIGNS_TRACKED_TOPIC}`, LOG_CONTEXT);
  }

  private async handle(
    msg: BrokerMessage<CampaignsTrackedContract>,
  ): Promise<void> {
    if (!isCampaignsTrackedContract(msg.payload)) {
      this.logger.warn(
        `Invalid ${CAMPAIGNS_TRACKED_TOPIC} payload (messageId=${msg.id}) — nack(requeue=false)`,
        LOG_CONTEXT,
      );
      await this.broker.nack(msg, false);
      return;
    }

    const payload = msg.payload;

    await this.correlation.runWithCorrelationId(payload.correlationId, () =>
      processWithAckPolicy(
        msg,
        this.broker,
        {
          logger: this.logger,
          context: LOG_CONTEXT,
          meta: { campaignId: payload.campaignId, page: payload.page },
        },
        async () => {
          await this.tracker.record(payload);
        },
      ),
    );
  }
}
