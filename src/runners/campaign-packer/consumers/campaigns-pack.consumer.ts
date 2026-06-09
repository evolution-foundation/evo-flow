import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
  BrokerMessage,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_PACK_TOPIC,
  isCampaignsPackContract,
  type CampaignsPackContract,
} from '../../../shared/broker/contracts/campaigns-pack.contract';
import { CorrelationContext } from '../../../shared/correlation/correlation.context';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { CampaignPackerService } from '../services/campaign-packer.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';

const LOG_CONTEXT = 'CampaignsPackConsumer';

/**
 * Broker consumer for `campaigns.pack` (story 4.1 / EVO-1215). Subscribes on
 * boot and routes each message to `CampaignPackerService`, wrapping processing
 * in the request's `correlationId` so every downstream log carries it.
 *
 * Ack/nack policy:
 *  - success → ack
 *  - campaign not found / malformed payload → nack(requeue=false) (terminal)
 *  - any other (transient) error → nack(requeue=true) (retry)
 */
@Injectable()
export class CampaignsPackConsumer implements OnModuleInit {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly packer: CampaignPackerService,
    private readonly correlation: CorrelationContext,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.broker.subscribe<CampaignsPackContract>(
      CAMPAIGNS_PACK_TOPIC,
      (msg) => this.handle(msg),
    );
    this.logger.log(`Subscribed to ${CAMPAIGNS_PACK_TOPIC}`, LOG_CONTEXT);
  }

  private async handle(
    msg: BrokerMessage<CampaignsPackContract>,
  ): Promise<void> {
    if (!isCampaignsPackContract(msg.payload)) {
      this.logger.warn(
        `Invalid ${CAMPAIGNS_PACK_TOPIC} payload (messageId=${msg.id}) — nack(requeue=false)`,
        LOG_CONTEXT,
      );
      await this.broker.nack(msg, false);
      return;
    }

    const payload = msg.payload;

    await this.correlation.runWithCorrelationId(
      payload.correlationId,
      async () => {
        try {
          await this.packer.pack(payload);
          await this.broker.ack(msg);
        } catch (err) {
          if (err instanceof CampaignNotFoundError) {
            this.logger.warn(
              `campaign not found (campaignId=${err.campaignId}) — nack(requeue=false)`,
              LOG_CONTEXT,
            );
            await this.broker.nack(msg, false);
            return;
          }

          this.logger.error(
            `campaigns.pack processing failed (campaignId=${payload.campaignId}): ${
              err instanceof Error ? err.message : String(err)
            } — nack(requeue=true)`,
            err instanceof Error ? err.stack : undefined,
            LOG_CONTEXT,
          );
          await this.broker.nack(msg, true);
        }
      },
    );
  }
}
