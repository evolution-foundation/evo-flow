import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Campaign } from './campaign.entity';

@Entity('campaigns_templates')
@Index(['campaignId'])
@Index(['messageTemplateId'])
@Index(['campaignId', 'variant'])
export class CampaignTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @Column({ name: 'message_template_id', type: 'uuid' })
  messageTemplateId: string;

  @Column({ length: 10, default: 'A' })
  variant: string;

  @Column({ name: 'is_winner', type: 'boolean', default: false })
  isWinner: boolean;

  @Column({ type: 'jsonb', default: {} })
  statistics: any;

  @ManyToOne(() => Campaign, campaign => campaign.templates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
