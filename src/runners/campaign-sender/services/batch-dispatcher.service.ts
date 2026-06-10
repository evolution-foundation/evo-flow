import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Counter, register } from 'prom-client';
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

// "retry N times" per the story: 1 initial attempt + DISPATCH_RETRY_COUNT
// retries (same retries-not-attempts convention as the rate limiter / 4.4),
// sleeping base*2^n capped at DISPATCH_BACKOFF_CAP_MS before each retry.
const DEFAULT_DISPATCH_RETRY_COUNT = 3;
const DEFAULT_DISPATCH_BACKOFF_BASE_MS = 1_000;
const DEFAULT_DISPATCH_BACKOFF_CAP_MS = 30_000;
// Backoff sleeps are sliced so a pause/stop is noticed within ~1s even while
// waiting out a capped 30s backoff (the story's "do not block for 30s" note).
const ABORT_POLL_INTERVAL_MS = 1_000;

const DISPATCH_RETRIES_METRIC = 'evo_flow_dispatch_retries_total';
const DISPATCH_TERMINAL_FAILURES_METRIC =
  'evo_flow_dispatch_terminal_failures_total';

/** Why the sender wants the retry loop to stop (campaign no longer Sending). */
export type DispatchAbortReason = 'paused' | 'stopped';

export interface BatchDispatchInput {
  campaignId: string;
  inboxId: string;
  template: MessageTemplate;
  contact: HydratedContact;
  /**
   * Sender-provided probe polled before/during every backoff sleep. Returning
   * a reason aborts the remaining retries WITHOUT failing the contact — the
   * row stays PENDING and is reprocessed on resume.
   */
  shouldAbort?: () => Promise<DispatchAbortReason | null>;
}

export type BatchDispatchOutcome =
  | { kind: 'sent'; result: DispatchResult }
  | {
      kind: 'failed';
      reason: string;
      statusCode?: number;
      result: DispatchResult;
    }
  | { kind: 'aborted'; abortReason: DispatchAbortReason };

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
 * Every dispatch attempt first acquires a token from the per-inbox rate
 * limiter (story 4.4 / EVO-1218) with soft backpressure: up to
 * {@link RATE_LIMIT_RETRIES} retries sleeping {@link RATE_LIMIT_RETRY_DELAY_MS}
 * between attempts — absorbing a lightly saturated bucket without bouncing the
 * message through the broker. Still blocked after that → `RateLimitedError`,
 * which the ack policy turns into `nack(requeue=true)`.
 *
 * Retry policy (story 4.5 / EVO-1219): transient failures — HTTP 5xx or
 * network errors (no statusCode) — retry with exponential backoff
 * (base*2^n, capped); 4xx is a permanent failure with no retry (429 included:
 * the dispatch runs with transportRetries=1, which also disables the legacy
 * in-transport network/429 retries on this path, making this loop the single
 * owner of the retry policy). Every retry attempt re-acquires a rate-limit
 * token. During each backoff the sender's `shouldAbort` probe is polled so a
 * paused/stopped campaign stops retrying within ~1s — aborting acks the page
 * without failing the contact (PENDING rows are reprocessed on resume).
 */
@Injectable()
export class BatchDispatcherService {
  private readonly mode = process.env.RUN_MODE ?? 'unknown';
  private readonly retriesTotal: Counter<string>;
  private readonly terminalFailuresTotal: Counter<string>;

  constructor(
    private readonly db: TenantDbContext,
    private readonly crmInboxDispatcher: CrmInboxDispatcher,
    private readonly rateLimiter: RateLimiterService,
    private readonly logger: CustomLoggerService,
  ) {
    this.retriesTotal =
      (register.getSingleMetric(DISPATCH_RETRIES_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: DISPATCH_RETRIES_METRIC,
        help: 'Dispatch retry attempts executed after a transient failure, labeled by retry number',
        labelNames: ['mode', 'attempt'],
      });

    this.terminalFailuresTotal =
      (register.getSingleMetric(DISPATCH_TERMINAL_FAILURES_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: DISPATCH_TERMINAL_FAILURES_METRIC,
        help: 'Contacts marked FAILED by the dispatch retry policy (http_4xx or exhausted_retries)',
        labelNames: ['mode', 'reason'],
      });
  }

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

  async dispatch(input: BatchDispatchInput): Promise<BatchDispatchOutcome> {
    const { campaignId, inboxId, contact } = input;
    const retryCount = this.retryCount();
    const attemptErrors: string[] = [];

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      await this.acquireWithBackpressure(inboxId);
      // Counted only after the token is acquired: a retry killed by
      // RateLimitedError requeues the page and never executes.
      if (attempt > 0) {
        this.retriesTotal.labels(this.mode, String(attempt)).inc();
      }

      const result = await this.dispatchOnce(input);

      if (result.success) {
        return { kind: 'sent', result };
      }

      const statusCode = result.statusCode;
      if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        this.terminalFailuresTotal.labels(this.mode, 'http_4xx').inc();
        return {
          kind: 'failed',
          reason: `http_4xx: ${statusCode}`,
          statusCode,
          result,
        };
      }

      // Transient: HTTP 5xx, or a network error (no statusCode at all).
      attemptErrors.push(
        statusCode !== undefined
          ? String(statusCode)
          : (result.error?.code ?? 'network'),
      );

      if (attempt === retryCount) {
        this.terminalFailuresTotal.labels(this.mode, 'exhausted_retries').inc();
        return {
          kind: 'failed',
          reason: `dispatch_exhausted_retries: ${JSON.stringify(attemptErrors)}`,
          statusCode,
          result,
        };
      }

      const delayMs = Math.min(
        this.backoffBaseMs() * 2 ** attempt,
        this.backoffCapMs(),
      );
      this.logger.warn('dispatch retry scheduled', {
        campaignId,
        contactId: contact.id,
        attempt: attempt + 1,
        backoffMs: delayMs,
        error: attemptErrors[attemptErrors.length - 1],
      });

      const abortReason = await this.backoffOrAbort(delayMs, input.shouldAbort);
      if (abortReason) {
        this.logger.warn(`aborted: campaign ${abortReason} during retry`, {
          campaignId,
          contactId: contact.id,
          attempt: attempt + 1,
        });
        return { kind: 'aborted', abortReason };
      }
    }

    // Unreachable: the loop always returns on success, 4xx, exhaustion or abort.
    throw new Error('dispatch retry loop exited without an outcome');
  }

  /**
   * One transport-level attempt. transportRetries=1 disables the legacy quick
   * network/429 retries inside CrmInboxDispatcher — on this path the retry
   * policy is owned exclusively by the loop above (story 4.5).
   */
  private dispatchOnce(input: BatchDispatchInput): Promise<DispatchResult> {
    const { campaignId, inboxId, template, contact } = input;
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
      transportRetries: 1,
    });
  }

  /**
   * Interruptible backoff: checks `shouldAbort` up front, then sleeps in
   * ≤{@link ABORT_POLL_INTERVAL_MS} slices re-checking between slices, with a
   * final check after the full delay (i.e. "before the next attempt").
   */
  private async backoffOrAbort(
    delayMs: number,
    shouldAbort?: () => Promise<DispatchAbortReason | null>,
  ): Promise<DispatchAbortReason | null> {
    if (!shouldAbort) {
      await this.sleep(delayMs);
      return null;
    }

    let remaining = delayMs;
    for (;;) {
      const reason = await shouldAbort();
      if (reason) return reason;
      if (remaining <= 0) return null;
      const slice = Math.min(remaining, ABORT_POLL_INTERVAL_MS);
      await this.sleep(slice);
      remaining -= slice;
    }
  }

  private retryCount(): number {
    // min 0: DISPATCH_RETRY_COUNT=0 is a legitimate "no retries" override.
    return this.envInt('DISPATCH_RETRY_COUNT', DEFAULT_DISPATCH_RETRY_COUNT, 0);
  }

  private backoffBaseMs(): number {
    return this.envInt(
      'DISPATCH_BACKOFF_BASE_MS',
      DEFAULT_DISPATCH_BACKOFF_BASE_MS,
    );
  }

  private backoffCapMs(): number {
    return this.envInt(
      'DISPATCH_BACKOFF_CAP_MS',
      DEFAULT_DISPATCH_BACKOFF_CAP_MS,
    );
  }

  private envInt(name: string, fallback: number, min = 1): number {
    const parsed = parseInt(process.env[name] ?? String(fallback), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
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
