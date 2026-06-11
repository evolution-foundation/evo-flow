import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  Campaign,
  CampaignStatus,
  CampaignType,
} from '../../../modules/campaigns/entities/campaign.entity';
import { CampaignTemplate } from '../../../modules/campaigns/entities/campaign-template.entity';
import { CampaignTrackedPage } from '../../../modules/campaigns/entities/campaign-tracked-page.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import type { CampaignsTrackedContract } from '../../../shared/broker/contracts/campaigns-tracked.contract';

type CampaignProgress = Pick<Campaign, 'id' | 'type' | 'status'>;

/**
 * Tail of the distributed campaign pipeline (story 4.6 / EVO-1220): the
 * broker-native aggregator for `campaigns.tracked`. Each page report
 * idempotently increments the campaign's Postgres counters and, once every
 * page has reported, transitions the campaign to `Completed` and (for testAB)
 * selects the A/B winner.
 *
 * Idempotency against the broker's at-least-once delivery is tabular: the
 * `campaign_tracked_pages` ledger has a UNIQUE(campaign_id, page) constraint,
 * so a redelivered report inserts nothing and skips the counter increment.
 * Completion is durable too — it counts distinct reported pages against
 * `campaigns.total_pages` (learned from the page whose report carries
 * `completed=true`), so it survives a consumer restart that an in-memory
 * `Set<page>` would not.
 */
@Injectable()
export class CampaignTrackerService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly logger: CustomLoggerService,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get trackedPageRepository(): Repository<CampaignTrackedPage> {
    return this.db.getRepository(CampaignTrackedPage);
  }

  private get campaignTemplateRepository(): Repository<CampaignTemplate> {
    return this.db.getRepository(CampaignTemplate);
  }

  async record(payload: CampaignsTrackedContract): Promise<void> {
    const { campaignId, page, completed } = payload;

    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
      select: { id: true, type: true, status: true },
    });
    if (!campaign) {
      // A report for a campaign that no longer exists is a benign no-op —
      // drop it (ack) instead of requeueing forever.
      this.logger.warn('tracked: campaign not found', { campaignId, page });
      return;
    }

    if (campaign.status === CampaignStatus.COMPLETED) {
      // Already finalized — ignore late or duplicate page reports.
      return;
    }

    // AC4: an empty audience is reported by the packer as a single completed
    // page 0 with no contacts. Complete straight away without waiting for
    // sender pages (there are none).
    if (completed && page === 0) {
      await this.transitionToCompleted(campaign);
      return;
    }

    await this.recordPage(payload);
    await this.recomputeCounters(campaignId);

    if (completed) {
      await this.recordTotalPages(campaignId, page);
    }

    await this.completeIfAllPagesReported(campaign);
  }

  /**
   * Append the page to the ledger. The UNIQUE(campaign_id, page) constraint +
   * ON CONFLICT DO NOTHING make a redelivered report a no-op, so each page's
   * counts land in the ledger exactly once.
   */
  private async recordPage(payload: CampaignsTrackedContract): Promise<void> {
    await this.trackedPageRepository.query(
      `INSERT INTO campaign_tracked_pages (campaign_id, page, sent_count, failed_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, page) DO NOTHING`,
      [
        payload.campaignId,
        payload.page,
        payload.sentCount,
        payload.failedCount,
      ],
    );
  }

  /**
   * Derive the campaign counters from the ledger (SUM), never increment.
   * Recomputing from the source of truth is idempotent by construction: a
   * redelivered page (already in the ledger, ON CONFLICT) yields the same sum,
   * and a crash between the ledger insert and this recompute self-heals on the
   * next report — an additive `+= sentCount` would double-count the former and
   * permanently lose the latter.
   */
  private async recomputeCounters(campaignId: string): Promise<void> {
    await this.campaignRepository.query(
      `UPDATE campaigns c
          SET sent_contacts = COALESCE(agg.sent, 0),
              failed_contacts = COALESCE(agg.failed, 0)
         FROM (
           SELECT SUM(sent_count) AS sent, SUM(failed_count) AS failed
             FROM campaign_tracked_pages
            WHERE campaign_id = $1
         ) agg
        WHERE c.id = $1`,
      [campaignId],
    );
  }

  /**
   * The sender stamps `completed = page === totalPages` on the last page, so
   * the completed report's own page number IS the total page count.
   */
  private async recordTotalPages(
    campaignId: string,
    totalPages: number,
  ): Promise<void> {
    await this.campaignRepository.query(
      `UPDATE campaigns SET total_pages = $1 WHERE id = $2`,
      [totalPages, campaignId],
    );
  }

  private async completeIfAllPagesReported(
    campaign: CampaignProgress,
  ): Promise<void> {
    const rows = (await this.campaignRepository.query(
      `SELECT c.total_pages AS total_pages,
              (SELECT COUNT(*)::int
                 FROM campaign_tracked_pages t
                WHERE t.campaign_id = c.id) AS reported
         FROM campaigns c
        WHERE c.id = $1`,
      [campaign.id],
    )) as Array<{ total_pages: number | null; reported: number }>;

    const agg = rows[0];
    const totalPages: number | null = agg?.total_pages ?? null;
    const reported: number = agg?.reported ?? 0;
    if (totalPages === null || reported < totalPages) {
      return;
    }

    await this.transitionToCompleted(campaign);
  }

  /**
   * Gated status transition: the `status != COMPLETED` predicate makes this
   * idempotent and race-safe — concurrent final pages contend on the row, only
   * the first UPDATE affects a row, so the A/B winner selection runs once.
   */
  private async transitionToCompleted(
    campaign: CampaignProgress,
  ): Promise<void> {
    const result = await this.campaignRepository
      .createQueryBuilder()
      .update(Campaign)
      .set({ status: CampaignStatus.COMPLETED })
      .where('id = :id AND status != :completed', {
        id: campaign.id,
        completed: CampaignStatus.COMPLETED,
      })
      .execute();

    if ((result.affected ?? 0) === 0) {
      return;
    }

    this.logger.log('campaign.completed', { campaignId: campaign.id });

    if (campaign.type === CampaignType.TESTAB) {
      // Best-effort: the campaign is already Completed, and a redelivery would
      // short-circuit on the COMPLETED guard before reaching here — so a winner
      // failure must not throw, or it would be permanently skipped. Log and move
      // on (AC3 is best-effort until per-variant counters flow through tracked).
      try {
        await this.selectAbWinner(campaign.id);
      } catch (err) {
        this.logger.error('ab winner selection failed', {
          campaignId: campaign.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Best-effort A/B winner selection (story 4.6 / EVO-1220). Per-variant
   * counters do NOT flow through `campaigns.tracked` yet — the packer dispatches
   * only variant A — so with empty `statistics` this falls back to variant A.
   * It reads the campaign's configured `testab_winner_criteria` against each
   * template's `statistics` jsonb, so a future split story that populates those
   * stats selects the real winner without changing this code.
   */
  private async selectAbWinner(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
      select: { id: true, testabWinnerCriteria: true },
    });
    const templates = await this.campaignTemplateRepository.find({
      where: { campaignId },
      order: { variant: 'ASC' },
    });
    if (templates.length === 0) {
      this.logger.warn('ab winner: campaign has no templates', { campaignId });
      return;
    }

    const criteria = campaign?.testabWinnerCriteria ?? null;
    const winner = this.pickWinner(templates, criteria);

    await this.campaignTemplateRepository.update(
      { campaignId },
      { isWinner: false },
    );
    await this.campaignTemplateRepository.update(
      { id: winner.id },
      { isWinner: true },
    );

    this.logger.log('campaign.ab_winner.selected', {
      campaignId,
      winnerTemplateId: winner.id,
      variant: winner.variant,
      criteria,
    });
  }

  private pickWinner(
    templates: CampaignTemplate[],
    criteria: string | null,
  ): CampaignTemplate {
    const metric = criteria && criteria.trim().length > 0 ? criteria : 'sent';
    let best = templates[0];
    let bestScore = this.metricValue(best, metric);
    for (const template of templates.slice(1)) {
      const score = this.metricValue(template, metric);
      if (score > bestScore) {
        best = template;
        bestScore = score;
      }
    }
    return best;
  }

  private metricValue(template: CampaignTemplate, metric: string): number {
    const stats = (template.statistics ?? {}) as Record<string, unknown>;
    const raw = stats[metric];
    return typeof raw === 'number' ? raw : 0;
  }
}
