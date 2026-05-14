import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Journey } from './journey.entity';
import { JourneySession } from './journey-session.entity';

export enum ScheduledActionStatus {
  PENDING = 'pending',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ScheduledActionConfig {
  delayDuration: number;
  delayUnit: 'minutes' | 'hours' | 'days' | 'weeks';
  actionType: string;
  actionConfig: Record<string, any>;
  retryPolicy?: {
    maxRetries: number;
    backoffMultiplier: number;
  };
}

@Entity('scheduled_journey_actions')
@Index(['journeyId'])
@Index(['sessionId'])
@Index(['contactId'])
@Index(['status'])
@Index(['scheduledFor'])
@Index(['status', 'scheduledFor'])
export class ScheduledJourneyAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'journey_id', type: 'uuid' })
  journeyId: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  @Column({ name: 'contact_id', type: 'uuid' })
  contactId: string;

  @Column({ name: 'node_id', type: 'varchar' })
  nodeId: string;

  @Column({
    name: 'action_config',
    type: 'jsonb',
    default: {},
  })
  actionConfig: ScheduledActionConfig;

  @Column({
    name: 'scheduled_for',
    type: 'timestamp',
  })
  scheduledFor: Date;

  @Column({
    name: 'executed_at',
    type: 'timestamp',
    nullable: true,
  })
  executedAt?: Date;

  @Column({
    type: 'enum',
    enum: ScheduledActionStatus,
    default: ScheduledActionStatus.PENDING,
  })
  status: ScheduledActionStatus;

  @Column({
    name: 'error_message',
    type: 'text',
    nullable: true,
  })
  errorMessage?: string;

  @Column({
    name: 'retry_count',
    type: 'integer',
    default: 0,
  })
  retryCount: number;

  @Column({
    name: 'max_retries',
    type: 'integer',
    default: 3,
  })
  maxRetries: number;

  @Column({
    name: 'scheduled_action_id',
    type: 'bigint',
    nullable: true,
  })
  scheduledActionId?: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Helper methods
  get isDue(): boolean {
    return new Date() >= this.scheduledFor && this.status === ScheduledActionStatus.PENDING;
  }

  get isOverdue(): boolean {
    return new Date() > this.scheduledFor && this.status === ScheduledActionStatus.PENDING;
  }

  get canRetry(): boolean {
    return this.status === ScheduledActionStatus.FAILED && this.retryCount < this.maxRetries;
  }

  get timeUntilExecution(): number {
    const now = new Date().getTime();
    const scheduled = new Date(this.scheduledFor).getTime();
    return Math.max(0, Math.floor((scheduled - now) / 1000));
  }

  markAsExecuting(): void {
    this.status = ScheduledActionStatus.EXECUTING;
  }

  markAsCompleted(executedAt?: Date): void {
    this.status = ScheduledActionStatus.COMPLETED;
    this.executedAt = executedAt || new Date();
    this.errorMessage = undefined;
  }

  markAsFailed(error: string): void {
    this.status = ScheduledActionStatus.FAILED;
    this.errorMessage = error;
    this.retryCount++;
  }

  markAsCancelled(): void {
    this.status = ScheduledActionStatus.CANCELLED;
  }
}
