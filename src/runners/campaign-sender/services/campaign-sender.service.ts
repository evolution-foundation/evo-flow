import { Inject, Injectable } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import {
  Campaign,
  CampaignStatus,
} from '../../../modules/campaigns/entities/campaign.entity';
import {
  CampaignContact,
  CampaignContactStatus,
} from '../../../modules/campaigns/entities/campaign-contact.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import {
  mapContactDto,
  type HydratedContact,
} from '../../../shared/crm-client/types/contact';
import { PipelineMetricsService } from '../../../shared/metrics/pipeline-metrics.service';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
} from '../../../shared/broker/interfaces/message-broker.interface';
import type { CampaignsSendContract } from '../../../shared/broker/contracts/campaigns-send.contract';
import {
  CAMPAIGNS_TRACKED_TOPIC,
  CampaignsTrackedContract,
} from '../../../shared/broker/contracts/campaigns-tracked.contract';
import {
  BatchDispatcherService,
  type DispatchAbortReason,
} from './batch-dispatcher.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';

export interface SendResult {
  dispatched: number;
  skipped: number;
  failed: number;
  aborted: boolean;
}

const DEFAULT_STATUS_CACHE_TTL_MS = 5_000;
const STATUS_CACHE_MAX_ENTRIES = 1_000;

const DISPATCHABLE_STATUSES = new Set<CampaignStatus>([
  CampaignStatus.SENDING,
  CampaignStatus.SENDING_TESTAB,
]);

/**
 * Consumer-side core of the campaign dispatch pipeline (story 4.3 / EVO-1217):
 * processes one `campaigns.send` page — hydrates the batch's contacts from the
 * CRM, dispatches each PENDING contact through the shared CRM inbox dispatcher
 * and records the outcome on `CampaignContact.status` (FR5).
 *
 * Idempotency is tabular (FR30, NFR16): `status` is the lock. Non-PENDING
 * contacts are skipped, and the SENT/FAILED updates are conditional on
 * `status='PENDING'` so a redelivery or replica race never double-marks a row.
 *
 * Pause/stop (FR21–FR24) is honored by rechecking `Campaign.status` before
 * every dispatch through a per-instance TTL cache — eventually consistent by
 * design (NFR5 allows ≤30s propagation), trading staleness for not hammering
 * Postgres once per contact.
 *
 * Dispatch goes through the BatchDispatcherService retry policy (4.5):
 * transient failures back off exponentially, 4xx fails immediately, and a
 * pause/stop during a backoff aborts the page without failing the contact.
 * Out of scope here by contract: `campaigns.tracked` publishing (4.6) and
 * `campaigns.control` consumption (4.8).
 */
@Injectable()
export class CampaignSenderService {
  private readonly statusCache = new Map<
    string,
    { status: CampaignStatus; fetchedAt: number }
  >();

  constructor(
    private readonly db: TenantDbContext,
    private readonly contactsClient: ContactsClientService,
    private readonly logger: CustomLoggerService,
    private readonly metrics: PipelineMetricsService,
    private readonly batchDispatcher: BatchDispatcherService,
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get campaignContactRepository(): Repository<CampaignContact> {
    return this.db.getRepository(CampaignContact);
  }

  /**
   * EVO-1222 [4.8]: drop the cached status for a campaign so the next dispatch
   * recheck re-reads the authoritative Postgres flag immediately instead of
   * waiting out the TTL. Invoked by the `campaigns.control` consumer on
   * pause/stop/resume — the fast-path half of the hybrid design.
   */
  invalidateStatusCache(campaignId: string): void {
    this.statusCache.delete(campaignId);
  }

  async send(payload: CampaignsSendContract): Promise<SendResult> {
    const { campaignId, page, totalPages } = payload;
    const result: SendResult = {
      dispatched: 0,
      skipped: 0,
      failed: 0,
      aborted: false,
    };

    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
    }
    if (!campaign.inboxId) {
      throw new CampaignNotConfiguredError(
        campaignId,
        'campaign has no inboxId',
      );
    }

    this.cacheStatus(campaignId, campaign.status);
    if (!DISPATCHABLE_STATUSES.has(campaign.status)) {
      result.aborted = true;
      this.logAborted(campaign.status, { campaignId, page });
      return result;
    }

    const template = await this.batchDispatcher.loadTemplate(
      campaignId,
      payload.templateId,
    );

    // Dedupe defensively: the packer never repeats an id within a page, but a
    // duplicated id would dispatch twice (the in-memory row stays PENDING
    // after the first send — the tabular lock only guards cross-process races).
    const contactIds = Array.from(new Set(payload.contactIds));

    const rows = await this.campaignContactRepository.find({
      where: { campaignId, contactId: In(contactIds) },
    });
    const rowByContactId = new Map(rows.map((row) => [row.contactId, row]));

    // Hydrate only contacts that can actually dispatch — a redelivered page of
    // already-SENT contacts must skip cheaply (NFR16), not re-fetch the whole
    // batch from the CRM.
    const pendingIds = contactIds.filter(
      (id) => rowByContactId.get(id)?.status === CampaignContactStatus.PENDING,
    );
    const contacts = await this.hydrateContacts(pendingIds);

    for (const contactId of contactIds) {
      const row = rowByContactId.get(contactId);
      if (!row) {
        result.skipped++;
        this.logger.warn('skipped: no campaign_contact row', {
          campaignId,
          contactId,
        });
        continue;
      }

      if (row.status !== CampaignContactStatus.PENDING) {
        result.skipped++;
        this.logger.log('skipped: already sent', {
          campaignId,
          contactId,
          status: row.status,
        });
        continue;
      }

      const currentStatus = await this.currentCampaignStatus(campaignId);
      if (!DISPATCHABLE_STATUSES.has(currentStatus)) {
        result.aborted = true;
        this.logAborted(currentStatus, { campaignId, page });
        break;
      }

      const contact = await this.resolveContact(contacts, contactId);
      if (!contact) {
        await this.markFailed(row, 'contact_not_found');
        this.metrics.incError('contact_not_found');
        result.failed++;
        continue;
      }

      if (contact.blocked) {
        await this.markSkipped(row);
        result.skipped++;
        this.logger.log('skipped: contact blocked', { campaignId, contactId });
        continue;
      }

      const outcome = await this.batchDispatcher.dispatch({
        campaignId,
        inboxId: campaign.inboxId,
        template,
        contact,
        shouldAbort: () => this.abortReasonFor(campaignId),
      });

      if (outcome.kind === 'aborted') {
        // Mid-retry pause/stop (4.5): the contact stays PENDING (no FAILED),
        // the batch is acked by returning normally, resume reprocesses it.
        result.aborted = true;
        this.logAborted(await this.currentCampaignStatus(campaignId), {
          campaignId,
          page,
        });
        break;
      }

      if (outcome.kind === 'sent') {
        const claimed = await this.markSent(row);
        if (claimed) {
          result.dispatched++;
          this.metrics.incThroughput();
        } else {
          // Another replica claimed the row between our read and the update.
          result.skipped++;
          this.logger.warn('skipped: already sent (lost claim race)', {
            campaignId,
            contactId,
          });
        }
      } else {
        await this.markFailed(row, outcome.reason, outcome.statusCode);
        this.metrics.incError(this.dispatchErrorCategory(outcome.statusCode));
        result.failed++;
      }
    }

    this.logger.log('campaign.batch.processed', {
      campaignId,
      page,
      totalPages,
      ...result,
    });

    // Close the progress loop (story 4.6 / EVO-1220): a fully-processed page
    // publishes `campaigns.tracked`. An aborted page (pause/stop) is NOT
    // reported — it stays unfinished and is reprocessed on resume, so reporting
    // it now would let the aggregator complete a campaign prematurely.
    if (!result.aborted) {
      await this.publishTracked(payload);
    }
    return result;
  }

  /**
   * Publish counts derived from the DB truth for this page, not from this run's
   * dispatch deltas. A page reprocessed after a publish failure (broker
   * at-least-once) finds its contacts already SENT and would report
   * `dispatched=0`; counting `CampaignContact.status` instead keeps the page's
   * `sentCount`/`failedCount` stable across redeliveries, so the aggregator's
   * per-page increment stays correct.
   */
  private async publishTracked(payload: CampaignsSendContract): Promise<void> {
    const { campaignId, page, totalPages } = payload;
    const contactIds = Array.from(new Set(payload.contactIds));

    const rows = await this.campaignContactRepository.find({
      where: { campaignId, contactId: In(contactIds) },
      select: { contactId: true, status: true },
    });

    let sentCount = 0;
    let failedCount = 0;
    for (const row of rows) {
      if (row.status === CampaignContactStatus.SENT) sentCount++;
      else if (row.status === CampaignContactStatus.FAILED) failedCount++;
    }

    const tracked: CampaignsTrackedContract = {
      campaignId,
      page,
      sentCount,
      failedCount,
      completed: page === totalPages,
      correlationId: payload.correlationId,
    };
    await this.broker.publish(CAMPAIGNS_TRACKED_TOPIC, tracked);

    this.logger.log('campaign.tracked.published', {
      campaignId,
      page,
      totalPages,
      sentCount,
      failedCount,
      completed: tracked.completed,
    });
  }

  /**
   * Hydrate the batch upfront with the pooled `findByIds` (10 concurrent, LRU
   * cached). It swallows per-contact transport errors as "missing", so a
   * missing id alone cannot distinguish a real 404 from a CRM outage —
   * `resolveContact` re-checks those before they are marked FAILED.
   */
  private async hydrateContacts(
    contactIds: string[],
  ): Promise<Map<string, HydratedContact>> {
    const dtos = await this.contactsClient.findByIds(contactIds);
    const contacts = new Map<string, HydratedContact>();
    for (const dto of dtos) {
      const contact = mapContactDto(dto);
      if (contact) contacts.set(contact.id, contact);
    }
    return contacts;
  }

  /**
   * A contact absent from the bulk hydration gets one direct lookup before
   * being failed: `findById` returns null on a genuine 404 (→ FAILED is
   * correct) but THROWS on a transient CRM error, which propagates to the
   * consumer as a requeue — so a CRM outage redelivers the batch instead of
   * mass-failing contacts that still exist.
   */
  private async resolveContact(
    contacts: Map<string, HydratedContact>,
    contactId: string,
  ): Promise<HydratedContact | null> {
    const cached = contacts.get(contactId);
    if (cached) return cached;
    return mapContactDto(await this.contactsClient.findById(contactId));
  }

  /**
   * Abort probe handed to the dispatcher's retry loop (4.5): polled during
   * backoff sleeps through the same TTL status cache, so a pause/stop stops
   * in-flight retries without hammering Postgres.
   */
  private async abortReasonFor(
    campaignId: string,
  ): Promise<DispatchAbortReason | null> {
    const status = await this.currentCampaignStatus(campaignId);
    if (DISPATCHABLE_STATUSES.has(status)) return null;
    return status === CampaignStatus.PAUSED ? 'paused' : 'stopped';
  }

  private async currentCampaignStatus(
    campaignId: string,
  ): Promise<CampaignStatus> {
    const cached = this.statusCache.get(campaignId);
    if (cached && Date.now() - cached.fetchedAt < this.statusCacheTtlMs()) {
      return cached.status;
    }
    const row = await this.campaignRepository.findOne({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    // A campaign deleted mid-batch behaves like a stop.
    const status = row?.status ?? CampaignStatus.STOPPED;
    this.cacheStatus(campaignId, status);
    return status;
  }

  private cacheStatus(campaignId: string, status: CampaignStatus): void {
    const now = Date.now();
    // The consumer is long-lived: prune expired entries so the cache cannot
    // grow unbounded across the campaigns this instance ever touched.
    if (this.statusCache.size >= STATUS_CACHE_MAX_ENTRIES) {
      for (const [key, entry] of this.statusCache) {
        if (now - entry.fetchedAt >= this.statusCacheTtlMs()) {
          this.statusCache.delete(key);
        }
      }
    }
    this.statusCache.set(campaignId, { status, fetchedAt: now });
  }

  private statusCacheTtlMs(): number {
    const parsed = parseInt(
      process.env.CAMPAIGN_STATUS_CACHE_TTL_MS ??
        String(DEFAULT_STATUS_CACHE_TTL_MS),
      10,
    );
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STATUS_CACHE_TTL_MS;
  }

  private logAborted(
    status: CampaignStatus,
    meta: Record<string, unknown>,
  ): void {
    this.logger.warn(`aborted: campaign ${this.statusLabel(status)}`, {
      ...meta,
      status: CampaignStatus[status],
    });
  }

  private statusLabel(status: CampaignStatus): string {
    switch (status) {
      case CampaignStatus.PAUSED:
        return 'paused';
      case CampaignStatus.STOPPED:
        return 'stopped';
      default:
        return `not dispatchable (${CampaignStatus[status]})`;
    }
  }

  /** Conditional on PENDING: the tabular idempotency lock (FR30, NFR16). */
  private async markSent(row: CampaignContact): Promise<boolean> {
    const updated = await this.campaignContactRepository.update(
      { id: row.id, status: CampaignContactStatus.PENDING },
      { status: CampaignContactStatus.SENT, sentAt: new Date() },
    );
    return (updated.affected ?? 0) > 0;
  }

  private async markSkipped(row: CampaignContact): Promise<void> {
    await this.campaignContactRepository.update(
      { id: row.id, status: CampaignContactStatus.PENDING },
      { status: CampaignContactStatus.SKIPPED },
    );
  }

  /**
   * CampaignContact has no failure-reason column; the reason is recorded in
   * the structured log (correlated via correlationId). Retry/backoff is story
   * 4.5 — here both 4xx and exhausted 5xx fail the contact immediately (FR33).
   */
  private async markFailed(
    row: CampaignContact,
    reason: string,
    statusCode?: number,
  ): Promise<void> {
    await this.campaignContactRepository.update(
      { id: row.id, status: CampaignContactStatus.PENDING },
      { status: CampaignContactStatus.FAILED },
    );
    this.logger.error('campaign contact failed', {
      campaignId: row.campaignId,
      contactId: row.contactId,
      statusCode,
      reason,
    });
  }

  private dispatchErrorCategory(statusCode?: number): string {
    if (statusCode === undefined) return 'dispatch_network';
    if (statusCode >= 400 && statusCode < 500) return 'dispatch_4xx';
    if (statusCode >= 500) return 'dispatch_5xx';
    return 'dispatch_unexpected';
  }
}
