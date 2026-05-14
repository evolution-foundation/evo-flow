import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Campaign } from './campaign.entity';

export enum CampaignExecutionStatus {
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('campaign_executions')
@Index(['campaignId'])
@Index(['campaignId', 'status'])
@Index(['workflowId'])
export class CampaignExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @Column({ name: 'workflow_id', type: 'varchar', length: 255 })
  workflowId: string;

  @Column({ name: 'run_id', type: 'varchar', length: 255 })
  runId: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: CampaignExecutionStatus.RUNNING,
  })
  status: CampaignExecutionStatus;

  @Column({ name: 'total_contacts', type: 'int', default: 0 })
  totalContacts: number;

  @Column({ name: 'processed_contacts', type: 'int', default: 0 })
  processedContacts: number;

  @Column({ name: 'sent_contacts', type: 'int', default: 0 })
  sentContacts: number;

  @Column({ name: 'failed_contacts', type: 'int', default: 0 })
  failedContacts: number;

  @Column({ name: 'current_batch', type: 'int', default: 0 })
  currentBatch: number;

  @Column({ name: 'total_batches', type: 'int', default: 0 })
  totalBatches: number;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
