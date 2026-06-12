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
import { CampaignSenderService } from '../services/campaign-sender.service';

const LOG_CONTEXT = 'CampaignsControlConsumer';

/**
 * Broker consumer for `campaigns.control` on the campaign-sender (story 4.8 /
 * EVO-1222) — the fast-path half of the hybrid pause/stop design. On any
 * control message it drops the campaign's cached status so the next dispatch
 * recheck re-reads the authoritative Postgres flag immediately (<1s) instead
 * of waiting out the 5s TTL. The Postgres flag stays the source of truth, so a
 * lost control message still aborts at the next TTL refresh (FR21–FR24, NFR5).
 *
 * A structurally invalid payload is dropped up-front (no correlationId to
 * bind). The action itself is not branched on: pause, stop and resume all just
 * invalidate the cache — the recheck then reads whatever status the REST call
 * already wrote.
 */
@Injectable()
export class CampaignsControlConsumer implements OnModuleInit {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly sender: CampaignSenderService,
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
          this.sender.invalidateStatusCache(payload.campaignId);
          return Promise.resolve();
        },
      ),
    );
  }
}
