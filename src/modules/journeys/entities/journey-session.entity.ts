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

export enum JourneySessionStatus {
  ACTIVE = 'active',
  WAITING = 'waiting',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface WaitingForData {
  nodeId: string;
  waitType: 'time' | 'event' | 'condition' | 'time_or_condition';
  conditions: any;
  expectedCompleteAt?: Date;
  fallbackAt?: Date;
}

@Entity('journey_sessions')
@Index(['contactId'])
@Index(['status'])
@Index(['journeyId'])
export class JourneySession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'journey_id', type: 'uuid' })
  journeyId: string;

  @Column({ name: 'contact_id', type: 'uuid' })
  contactId: string;

  @Column({
    type: 'enum',
    enum: JourneySessionStatus,
    default: JourneySessionStatus.ACTIVE,
  })
  status: JourneySessionStatus;

  @Column({ name: 'current_node_id', type: 'varchar', nullable: true })
  currentNodeId?: string;

  @Column({ name: 'waiting_for', type: 'jsonb', nullable: true })
  waitingFor?: WaitingForData;

  @Column({ type: 'jsonb', default: {} })
  variables: Record<string, any>;

  @Column({ name: 'workflow_id', type: 'varchar', nullable: true })
  workflowId?: string;

  @Column({ name: 'workflow_run_id', type: 'varchar', nullable: true })
  workflowRunId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt?: Date;

  @Column({ name: 'failed_at', type: 'timestamp', nullable: true })
  failedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  context?: Record<string, any>;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt?: Date;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount: number;

  @Column({ name: 'max_retries', type: 'integer', default: 3 })
  maxRetries: number;

  @Column({ name: 'execution_logs', type: 'jsonb', default: [] })
  executionLogs: Array<{
    nodeId: string;
    nodeType: string;
    status: 'started' | 'completed' | 'failed';
    timestamp: Date;
    executionTime?: number;
    result?: any;
    error?: string;
  }>;

  // Relations
  @ManyToOne(() => Journey)
  @JoinColumn({ name: 'journey_id' })
  journey?: Journey;

  // Helper methods
  updateCurrentNode(nodeId: string): void {
    this.currentNodeId = nodeId;
  }

  markAsCompleted(): void {
    this.status = JourneySessionStatus.COMPLETED;
    this.completedAt = new Date();
  }

  markAsFailed(reason?: string): void {
    this.status = JourneySessionStatus.FAILED;
    this.failedAt = new Date();
    if (reason) {
      this.errorMessage = reason;
    }
  }

  markAsCancelled(): void {
    this.status = JourneySessionStatus.CANCELLED;
  }

  addExecutionLog(
    nodeId: string,
    nodeType: string,
    status: 'started' | 'completed' | 'failed',
    data: {
      executionTime?: number;
      result?: any;
      error?: string;
    } = {},
  ): void {
    if (!this.executionLogs) {
      this.executionLogs = [];
    }

    this.executionLogs.push({
      nodeId,
      nodeType,
      status,
      timestamp: new Date(),
      ...data,
    });
  }

  getExecutionSummary(): { total: number; completed: number; failed: number } {
    if (!this.executionLogs) {
      return { total: 0, completed: 0, failed: 0 };
    }

    const completedNodes = this.executionLogs.filter(
      (log) => log.status === 'completed',
    );
    const failedNodes = this.executionLogs.filter(
      (log) => log.status === 'failed',
    );

    return {
      total: new Set(this.executionLogs.map((log) => log.nodeId)).size,
      completed: new Set(completedNodes.map((log) => log.nodeId)).size,
      failed: new Set(failedNodes.map((log) => log.nodeId)).size,
    };
  }
}
