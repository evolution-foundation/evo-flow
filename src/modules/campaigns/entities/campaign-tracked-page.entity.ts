import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Durable dedup ledger for campaign progress tracking (story 4.6 / EVO-1220):
 * one row per processed page. The UNIQUE(campaign_id, page) index makes a
 * redelivered `campaigns.tracked` message idempotent — the first insert wins,
 * later ones conflict and are dropped, so counters never double-count.
 */
@Entity('campaign_tracked_pages')
@Index('uq_campaign_tracked_pages_campaign_page', ['campaignId', 'page'], {
  unique: true,
})
export class CampaignTrackedPage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @Column({ type: 'int' })
  page: number;

  @Column({ name: 'sent_count', type: 'int', default: 0 })
  sentCount: number;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
