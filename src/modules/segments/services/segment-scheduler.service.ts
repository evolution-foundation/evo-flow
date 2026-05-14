import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  SegmentDistributedJobService,
  BatchJobRequest,
} from './segment-distributed-job.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import { Segment } from '../entities/segment.entity';
import {
  SegmentJobPriority,
  getSegmentKafkaConfig,
} from '../config/kafka-topics.config';
import { RunMode } from '../../processing/enums/run-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface ScheduledSegmentJob {
  id: string;
  segmentIds: string[];
  cronExpression: string;
  priority: SegmentJobPriority;
  isActive: boolean;
  lastRun?: Date;
  nextRun?: Date;
  metadata: {
    name: string;
    description?: string;
    createdBy: string;
    source: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface AutoScalingConfig {
  enabled: boolean;
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number; // Queue depth to scale up
  scaleDownThreshold: number; // Queue depth to scale down
  cooldownPeriod: number; // Seconds between scaling actions
  metricsWindow: number; // Seconds to look back for metrics
}

@Injectable()
export class SegmentSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    SegmentSchedulerService.name,
  );

  // In-memory store for scheduled jobs (in production, use database)
  private scheduledJobs = new Map<string, ScheduledSegmentJob>();
  private readonly kafkaConfig = getSegmentKafkaConfig();

  // Auto-scaling state
  private lastScalingAction = 0;
  private currentWorkerCount = 1;

  // Control flags
  private isEnabled = false;

  private readonly autoScalingConfig: AutoScalingConfig = {
    enabled: process.env.SEGMENT_AUTOSCALING_ENABLED === 'true',
    minWorkers: parseInt(process.env.SEGMENT_MIN_WORKERS || '1'),
    maxWorkers: parseInt(process.env.SEGMENT_MAX_WORKERS || '10'),
    scaleUpThreshold: parseInt(process.env.SEGMENT_SCALE_UP_THRESHOLD || '100'),
    scaleDownThreshold: parseInt(
      process.env.SEGMENT_SCALE_DOWN_THRESHOLD || '10',
    ),
    cooldownPeriod: parseInt(process.env.SEGMENT_SCALING_COOLDOWN || '300'), // 5 minutes
    metricsWindow: parseInt(process.env.SEGMENT_METRICS_WINDOW || '60'), // 1 minute
  };

  constructor(
    @InjectRepository(Segment)
    private readonly segmentRepository: Repository<Segment>,
    private readonly jobService: SegmentDistributedJobService,
    private readonly metrics: SegmentMetricsService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const runMode = this.configService.get<RunMode>('RUN_MODE', RunMode.SINGLE);

    // Only initialize in modes that handle segment processing
    if (runMode !== RunMode.SINGLE && runMode !== RunMode.SEGMENT_WORKER) {
      this.logger.log(
        `🎯 Segment Scheduler Service: Skipped (${runMode} mode - segment processing disabled)`,
      );
      return;
    }

    this.isEnabled = true;
    this.logger.log('Segment scheduler service initialized');
    this.logger.log(
      `Auto-scaling: ${this.autoScalingConfig.enabled ? 'enabled' : 'disabled'}`,
    );

    if (this.autoScalingConfig.enabled) {
      this.logger.log(
        `Auto-scaling config: min=${this.autoScalingConfig.minWorkers}, max=${this.autoScalingConfig.maxWorkers}, ` +
          `thresholds=[${this.autoScalingConfig.scaleDownThreshold}, ${this.autoScalingConfig.scaleUpThreshold}]`,
      );
    }
  }

  async onModuleDestroy() {
    this.logger.log('Segment scheduler service destroyed');
  }

  /**
   * Schedule a recurring segment computation job
   */
  async createScheduledJob(
    segmentIds: string[],
    cronExpression: string,
    priority: SegmentJobPriority = SegmentJobPriority.NORMAL,
    metadata: ScheduledSegmentJob['metadata'],
  ): Promise<ScheduledSegmentJob> {
    const job: ScheduledSegmentJob = {
      id: this.generateJobId(),
      segmentIds,
      cronExpression,
      priority,
      isActive: true,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Calculate next run time
    job.nextRun = this.calculateNextRun(cronExpression);

    this.scheduledJobs.set(job.id, job);

    this.logger.log(
      `Created scheduled job ${job.id} with ${segmentIds.length} segments (${cronExpression})`,
    );

    return job;
  }

  /**
   * Update a scheduled job
   */
  async updateScheduledJob(
    jobId: string,
    updates: Partial<
      Pick<
        ScheduledSegmentJob,
        'cronExpression' | 'priority' | 'isActive' | 'segmentIds'
      >
    >,
  ): Promise<ScheduledSegmentJob | null> {
    const job = this.scheduledJobs.get(jobId);
    if (!job) {
      return null;
    }

    // Apply updates
    Object.assign(job, updates);
    job.updatedAt = new Date();

    // Recalculate next run if cron expression changed
    if (updates.cronExpression) {
      job.nextRun = this.calculateNextRun(updates.cronExpression);
    }

    this.scheduledJobs.set(jobId, job);

    this.logger.log(`Updated scheduled job ${jobId}`);
    return job;
  }

  /**
   * Delete a scheduled job
   */
  async deleteScheduledJob(jobId: string): Promise<boolean> {
    const deleted = this.scheduledJobs.delete(jobId);
    if (deleted) {
      this.logger.log(`Deleted scheduled job ${jobId}`);
    }
    return deleted;
  }

  /**
   * Get all scheduled jobs
   */
  getScheduledJobs(): ScheduledSegmentJob[] {
    return Array.from(this.scheduledJobs.values());
  }

  /**
   * Main cron job that runs every minute to process scheduled jobs
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledJobs() {
    if (!this.isEnabled) {
      return;
    }
    const now = new Date();
    const dueJobs = Array.from(this.scheduledJobs.values()).filter(
      (job) => job.isActive && job.nextRun && job.nextRun <= now,
    );

    if (dueJobs.length === 0) {
      return;
    }

    this.logger.log(`Processing ${dueJobs.length} scheduled jobs`);

    for (const scheduledJob of dueJobs) {
      try {
        await this.executeScheduledJob(scheduledJob);
      } catch (error) {
        this.logger.error(
          `Error executing scheduled job ${scheduledJob.id}: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
    }
  }

  /**
   * Auto-scaling cron job that runs every 30 seconds
   */
  @Cron('*/30 * * * * *') // Every 30 seconds
  async performAutoScaling() {
    if (!this.isEnabled || !this.autoScalingConfig.enabled) {
      return;
    }

    const now = Date.now();
    const timeSinceLastScaling = now - this.lastScalingAction;

    // Check if we're in cooldown period
    if (timeSinceLastScaling < this.autoScalingConfig.cooldownPeriod * 1000) {
      return;
    }

    try {
      // Get queue depth metrics (placeholder - would query actual Kafka consumer lag)
      const queueDepth = await this.getQueueDepth();
      const processingRate = await this.getProcessingRate();

      this.logger.debug(
        `Auto-scaling check: queue depth=${queueDepth}, processing rate=${processingRate}/min, workers=${this.currentWorkerCount}`,
      );

      // Determine scaling action
      let targetWorkers = this.currentWorkerCount;

      if (queueDepth > this.autoScalingConfig.scaleUpThreshold) {
        // Scale up
        targetWorkers = Math.min(
          this.autoScalingConfig.maxWorkers,
          this.currentWorkerCount + 1,
        );
      } else if (queueDepth < this.autoScalingConfig.scaleDownThreshold) {
        // Scale down
        targetWorkers = Math.max(
          this.autoScalingConfig.minWorkers,
          this.currentWorkerCount - 1,
        );
      }

      // Execute scaling if needed
      if (targetWorkers !== this.currentWorkerCount) {
        await this.scaleWorkers(targetWorkers);
        this.lastScalingAction = now;
      }
    } catch (error) {
      this.logger.error(
        `Error during auto-scaling: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Health check cron job that runs every 5 minutes
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async healthCheck() {
    if (!this.isEnabled) {
      return;
    }
    try {
      const stats = await this.getSchedulerStats();

      this.logger.debug(
        `Scheduler health check: ${stats.activeJobs} active jobs, ${stats.totalJobs} total jobs, ` +
          `${stats.jobsExecutedToday} jobs executed today`,
      );

      // Record health metrics
      this.metrics.recordSegmentComputationAttempt({
        operation: 'scheduler_health_check',
      });
    } catch (error) {
      this.logger.error(
        `Scheduler health check failed: ${(error as Error).message}`,
      );

      this.metrics.recordSegmentComputationFailure({
        operation: 'scheduler_health_check',
        errorType: (error as Error).constructor.name,
      });
    }
  }

  private async executeScheduledJob(scheduledJob: ScheduledSegmentJob) {
    // Fetch current segment data
    const segments = await this.segmentRepository.find({
      where: {
        id: scheduledJob.segmentIds as any, // TypeORM In operator
        status: 'running',
      },
    });

    if (segments.length === 0) {
      this.logger.warn(
        `No active segments found for scheduled job ${scheduledJob.id}`,
      );
      return;
    }

    // Create batch job request
    const batchRequest: BatchJobRequest = {
      segments,
      priority: scheduledJob.priority,
      batchId: `scheduled-${scheduledJob.id}-${Date.now()}`,
      requestId: `scheduler-${scheduledJob.id}`,
      source: 'scheduler',
    };

    // Submit jobs
    const jobs = await this.jobService.createBatchJobs(batchRequest);

    // Update scheduled job
    scheduledJob.lastRun = new Date();
    scheduledJob.nextRun = this.calculateNextRun(scheduledJob.cronExpression);
    scheduledJob.updatedAt = new Date();

    this.scheduledJobs.set(scheduledJob.id, scheduledJob);

    this.logger.log(
      `Executed scheduled job ${scheduledJob.id}: created ${jobs.length} computation jobs`,
    );
  }

  private calculateNextRun(cronExpression: string): Date {
    // Simple implementation - in production, use a proper cron parser like node-cron
    const now = new Date();

    // For demo purposes, just add intervals based on common patterns
    if (cronExpression === CronExpression.EVERY_MINUTE) {
      return new Date(now.getTime() + 60000);
    } else if (cronExpression === CronExpression.EVERY_5_MINUTES) {
      return new Date(now.getTime() + 300000);
    } else if (cronExpression === CronExpression.EVERY_10_MINUTES) {
      return new Date(now.getTime() + 600000);
    } else if (cronExpression === CronExpression.EVERY_30_MINUTES) {
      return new Date(now.getTime() + 1800000);
    } else if (cronExpression === CronExpression.EVERY_HOUR) {
      return new Date(now.getTime() + 3600000);
    }

    // Default to 5 minutes if unknown pattern
    return new Date(now.getTime() + 300000);
  }

  private async getQueueDepth(): Promise<number> {
    // Placeholder - in production, query Kafka consumer lag
    // This would typically involve calling Kafka admin API to get consumer lag
    return Math.floor(Math.random() * 200); // Random for demo
  }

  private async getProcessingRate(): Promise<number> {
    // Placeholder - in production, calculate from metrics
    const summary = this.metrics.getMetricsSummary();
    return summary.segment_computation.total_requests || 0;
  }

  private async scaleWorkers(targetCount: number): Promise<void> {
    const action =
      targetCount > this.currentWorkerCount ? 'scale up' : 'scale down';

    this.logger.log(
      `Auto-scaling: ${action} from ${this.currentWorkerCount} to ${targetCount} workers`,
    );

    // In production, this would:
    // 1. Update Kubernetes deployment replicas
    // 2. Or start/stop Docker containers
    // 3. Or notify container orchestration system
    // 4. Update load balancer configuration

    // For now, just update our internal counter
    this.currentWorkerCount = targetCount;

    // Record scaling metrics
    this.metrics.recordSegmentComputationAttempt({
      operation: `auto_scale_${action.replace(' ', '_')}`,
    });
  }

  private generateJobId(): string {
    return `scheduled-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get scheduler statistics
   */
  async getSchedulerStats(): Promise<{
    totalJobs: number;
    activeJobs: number;
    jobsExecutedToday: number;
    nextJobRun?: Date;
    autoScaling: {
      enabled: boolean;
      currentWorkers: number;
      lastScalingAction: Date | null;
    };
  }> {
    const jobs = Array.from(this.scheduledJobs.values());
    const activeJobs = jobs.filter((job) => job.isActive);

    // Calculate jobs executed today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const jobsExecutedToday = jobs.filter(
      (job) => job.lastRun && job.lastRun >= today,
    ).length;

    // Find next job run
    const nextRuns = activeJobs
      .map((job) => job.nextRun)
      .filter((date) => date)
      .sort((a, b) => a!.getTime() - b!.getTime());

    return {
      totalJobs: jobs.length,
      activeJobs: activeJobs.length,
      jobsExecutedToday,
      nextJobRun: nextRuns[0],
      autoScaling: {
        enabled: this.autoScalingConfig.enabled,
        currentWorkers: this.currentWorkerCount,
        lastScalingAction:
          this.lastScalingAction > 0 ? new Date(this.lastScalingAction) : null,
      },
    };
  }

  /**
   * Manual trigger for a scheduled job
   */
  async triggerScheduledJob(jobId: string): Promise<boolean> {
    const job = this.scheduledJobs.get(jobId);
    if (!job || !job.isActive) {
      return false;
    }

    try {
      await this.executeScheduledJob(job);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to trigger scheduled job ${jobId}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
