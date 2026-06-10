import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { CrmInboxDispatcher } from '../../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';
import type { DispatchResult } from '../../../shared/messaging-channels/interfaces/channel-dispatcher.interface';
import type { HydratedContact } from '../../../shared/crm-client/types/contact';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import { RateLimitedError } from '../errors/rate-limited.error';
import { RateLimiterService } from './rate-limiter.service';

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 50;

export interface BatchDispatchInput {
  campaignId: string;
  inboxId: string;
  template: MessageTemplate;
  contact: HydratedContact;
}

/**
 * Batch-scoped dispatch helper for the campaign-sender (story 4.3 / EVO-1217):
 * loads the batch's MessageTemplate once, renders per-contact content and
 * delegates HTTP delivery to the shared CrmInboxDispatcher (story 2.2). The
 * dispatch path is channel-agnostic — the channel is carried by `inboxId`.
 *
 * Content rendering mirrors the legacy CampaignMessageSenderService
 * placeholder semantics ({contact.name} / {{contact.name}} / custom
 * attributes); the legacy path is removed by story 5.5.
 *
 * Every dispatch first acquires a token from the per-inbox rate limiter
 * (story 4.4 / EVO-1218) with soft backpressure: up to
 * {@link RATE_LIMIT_RETRIES} retries sleeping {@link RATE_LIMIT_RETRY_DELAY_MS}
 * between attempts — absorbing a lightly saturated bucket without bouncing the
 * message through the broker. Still blocked after that → `RateLimitedError`,
 * which the ack policy turns into `nack(requeue=true)`.
 */
@Injectable()
export class BatchDispatcherService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly crmInboxDispatcher: CrmInboxDispatcher,
    private readonly rateLimiter: RateLimiterService,
    private readonly logger: CustomLoggerService,
  ) {}

  private get messageTemplateRepository(): Repository<MessageTemplate> {
    return this.db.getRepository(MessageTemplate);
  }

  /**
   * Load the batch's template once. A missing template is terminal: every
   * contact in the batch would fail identically, so the whole message is
   * dropped to the DLQ instead of burning one FAILED row per contact.
   */
  async loadTemplate(
    campaignId: string,
    templateId: string,
  ): Promise<MessageTemplate> {
    const template = await this.messageTemplateRepository.findOne({
      where: { id: templateId },
    });
    if (!template) {
      throw new CampaignNotConfiguredError(
        campaignId,
        `message template ${templateId} not found`,
      );
    }
    return template;
  }

  async dispatch(input: BatchDispatchInput): Promise<DispatchResult> {
    const { campaignId, inboxId, template, contact } = input;
    await this.acquireWithBackpressure(inboxId);
    return this.crmInboxDispatcher.dispatch({
      contactId: contact.id,
      inboxId,
      content: this.renderContent(template.content, contact),
      campaignId,
      templateParams: {
        name: template.name,
        category: template.category || undefined,
        language: template.language || 'pt_BR',
        // Entity types `variables` as jsonb array; the legacy sender forwards
        // it verbatim as processed_params, so preserve the wire shape.
        processed_params: (template.variables ?? {}) as unknown as Record<
          string,
          unknown
        >,
      },
    });
  }

  /**
   * Soft backpressure: 1 acquire + up to {@link RATE_LIMIT_RETRIES} retries
   * 50ms apart. Beyond that the bucket is genuinely saturated — better to hand
   * the page back to the broker (requeue) than to hold the consumer hostage.
   *
   * Known interplay with the redelivery backstop (EVO-1677): each requeue
   * increments the delivery attempt, so a page that hits a saturated bucket on
   * `BROKER_DELIVERY_LIMIT` (default 3) consecutive deliveries is dead-lettered
   * to `campaigns.send.dlq` — its contacts stay PENDING until a manual replay.
   * Accepted for the MVP: sustained saturation means the queue is deep, so a
   * requeued page normally returns after the bucket refilled. A refill-aware
   * requeue delay is hardening scope (story 4.5+).
   */
  private async acquireWithBackpressure(inboxId: string): Promise<void> {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      if (attempt > 0) await this.sleep(RATE_LIMIT_RETRY_DELAY_MS);
      if (await this.rateLimiter.acquire(inboxId)) {
        if (attempt > 0) {
          this.logger.log(`rate-limit retry ${attempt}: acquired`, {
            inboxId,
          });
        }
        return;
      }
    }

    this.logger.warn('rate-limited: requeued', {
      inboxId,
      attempts: RATE_LIMIT_RETRIES + 1,
    });
    throw new RateLimitedError(inboxId, RATE_LIMIT_RETRIES + 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private renderContent(content: string, contact: HydratedContact): string {
    const values: Record<string, string> = {
      'contact.name': contact.name || '',
      'contact.email': contact.email || '',
      'contact.phone': contact.phoneNumber || '',
    };
    for (const [key, value] of Object.entries(contact.customAttributes ?? {})) {
      values[`contact.${key}`] =
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
    }

    let rendered = content;
    for (const [key, value] of Object.entries(values)) {
      // Double-brace form first, otherwise `{key}` would eat the inner braces
      // of `{{key}}` and leave a stray `{...}` around the value.
      rendered = rendered.replaceAll(`{{${key}}}`, value);
      rendered = rendered.replaceAll(`{${key}}`, value);
    }
    return rendered;
  }
}
