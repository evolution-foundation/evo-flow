import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
  BrokerMessage,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_SEND_TOPIC,
  isCampaignsSendContract,
  type CampaignsSendContract,
} from '../../../shared/broker/contracts/campaigns-send.contract';
import { CorrelationContext } from '../../../shared/correlation/correlation.context';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { PipelineMetricsService } from '../../../shared/metrics/pipeline-metrics.service';
import { processWithAckPolicy } from '../../../shared/broker/consumer/process-with-ack-policy';
import { CampaignSenderService } from '../services/campaign-sender.service';

const LOG_CONTEXT = 'CampaignsSendConsumer';
const DEFAULT_LAG_POLL_INTERVAL_MS = 15_000;

/**
 * Broker consumer for `campaigns.send` (story 4.3 / EVO-1217). Subscribes on
 * boot and routes each page batch to `CampaignSenderService`, wrapping
 * processing in the payload's `correlationId` so every downstream log carries
 * it. The consumer group is named per RUN_MODE by the broker adapter, so
 * multiple campaign-sender replicas share the topic's partitions (FR6).
 *
 * Ack/nack is delegated to the shared `processWithAckPolicy`: success (and a
 * pause/stop abort, which returns normally) → ack, `TerminalError` (campaign
 * or template missing) → nack(requeue=false), any other error →
 * nack(requeue=true). A structurally invalid payload is dropped up-front.
 *
 * Observability (NFR33, descoped here from EVO-1223): per-message duration
 * feeds the p50/p95/p99 summary, and a background poll publishes the topic's
 * consumer lag via `PipelineMetricsService.setConsumerLag`.
 */
@Injectable()
export class CampaignsSendConsumer implements OnModuleInit, OnModuleDestroy {
  private lagTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly sender: CampaignSenderService,
    private readonly correlation: CorrelationContext,
    private readonly logger: CustomLoggerService,
    private readonly metrics: PipelineMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.broker.subscribe<CampaignsSendContract>(
      CAMPAIGNS_SEND_TOPIC,
      (msg) => this.handle(msg),
    );
    this.logger.log(`Subscribed to ${CAMPAIGNS_SEND_TOPIC}`, LOG_CONTEXT);

    this.lagTimer = setInterval(
      () => void this.pollConsumerLag(),
      this.lagPollIntervalMs(),
    );
    // Lag polling must never keep a draining process alive.
    this.lagTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
  }

  private async handle(
    msg: BrokerMessage<CampaignsSendContract>,
  ): Promise<void> {
    if (!isCampaignsSendContract(msg.payload)) {
      this.logger.warn(
        `Invalid ${CAMPAIGNS_SEND_TOPIC} payload (messageId=${msg.id}) — nack(requeue=false)`,
        LOG_CONTEXT,
      );
      this.metrics.incError('malformed_payload');
      await this.broker.nack(msg, false);
      return;
    }

    const payload = msg.payload;
    const startedAt = Date.now();

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
          await this.sender.send(payload);
        },
      ),
    );

    this.metrics.observeRequestDuration(
      CAMPAIGNS_SEND_TOPIC,
      (Date.now() - startedAt) / 1000,
    );
  }

  private async pollConsumerLag(): Promise<void> {
    try {
      const lag = await this.broker.getTopicLag(CAMPAIGNS_SEND_TOPIC);
      this.metrics.setConsumerLag(CAMPAIGNS_SEND_TOPIC, lag);
    } catch (err) {
      // Best-effort: a failed poll must never disturb message processing.
      this.logger.warn(
        `consumer lag poll failed: ${(err as Error).message}`,
        LOG_CONTEXT,
      );
    }
  }

  private lagPollIntervalMs(): number {
    const parsed = parseInt(
      process.env.CAMPAIGN_SENDER_LAG_POLL_MS ??
        String(DEFAULT_LAG_POLL_INTERVAL_MS),
      10,
    );
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_LAG_POLL_INTERVAL_MS;
  }
}
