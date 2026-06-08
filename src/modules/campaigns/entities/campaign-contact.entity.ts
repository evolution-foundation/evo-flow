import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Campaign } from './campaign.entity';

export enum CampaignContactStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

@Entity('campaigns_contacts')
@Index(['campaignId'])
@Index(['contactId'])
@Index(['campaignId', 'createdAt', 'id'])
export class CampaignContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  /**
   * Foreign key to the CRM contact id. No ORM relation: the contacts table
   * lives in evo-ai-crm-community Postgres, not in evo-flow. Hydrate via
   * `ContactsClientService` when contact data is needed.
   */
  @Column({ name: 'contact_id', type: 'uuid' })
  contactId: string;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt?: Date;

  @Column({
    type: 'enum',
    enum: CampaignContactStatus,
    default: CampaignContactStatus.PENDING,
  })
  status?: CampaignContactStatus;

  @Column({ name: 'batch_sequence', type: 'int', nullable: true })
  batchSequence?: number;

  @ManyToOne(() => Campaign, campaign => campaign.campaignContacts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
