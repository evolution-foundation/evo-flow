import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
  BrokerMessage,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_CONTROL_TOPIC,
  isCampaignsControlContract,
  type CampaignsControlContract,
} from '../../../shared/broker/contracts/campaigns-control.contract';
import { CorrelationContext } from '../../../shared/correlation/correlation.context';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { processWithAckPolicy } from '../../../shared/broker/consumer/process-with-ack-policy';
import { CampaignPackerService } from '../services/campaign-packer.service';

const LOG_CONTEXT = 'CampaignsControlConsumer';

/**
 * Broker consumer for `campaigns.control` on the campaign-packer (story 4.8 /
 * EVO-1222). A pause/stop flags the campaign so an in-flight pagination stops
 * emitting further `campaigns.send` pages; a resume clears the flag. Pagination
 * is fast, so this rarely catches an active pack — but a 1M-contact audience
 * can be paused mid-split. The authoritative guard remains the sender's status
 * recheck; this only avoids queueing work that would be aborted anyway.
 *
 * A structurally invalid payload is dropped up-front (no correlationId to bind).
 */
@Injectable()
export class CampaignsControlConsumer implements OnModuleInit {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly packer: CampaignPackerService,
    private readonly correlation: CorrelationContext,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.broker.subscribe<CampaignsControlContract>(
      CAMPAIGNS_CONTROL_TOPIC,
      (msg) => this.handle(msg),
    );
    this.logger.log(`Subscribed to ${CAMPAIGNS_CONTROL_TOPIC}`, LOG_CONTEXT);
  }

  private async handle(
    msg: BrokerMessage<CampaignsControlContract>,
  ): Promise<void> {
    if (!isCampaignsControlContract(msg.payload)) {
      this.logger.warn(
        `Invalid ${CAMPAIGNS_CONTROL_TOPIC} payload (messageId=${msg.id}) — nack(requeue=false)`,
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
          meta: { campaignId: payload.campaignId, action: payload.action },
        },
        () => {
          if (payload.action === 'resume') {
            this.packer.clearPaginationAborted(payload.campaignId);
          } else {
            this.packer.markPaginationAborted(payload.campaignId);
          }
          return Promise.resolve();
        },
      ),
    );
  }
}
