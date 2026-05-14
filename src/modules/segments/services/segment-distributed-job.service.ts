import { Injectable } from '@nestjs/common';
import { KafkaService } from '../../processing/kafka/kafka.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import { Segment } from '../entities/segment.entity';
import {
  SEGMENT_KAFKA_TOPICS,
  SegmentJobPriority,
  SegmentJobStatus,
  getSegmentKafkaConfig,
} from '../config/kafka-topics.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentJob {
  id: string;
  segmentId: string;
  priority: SegmentJobPriority;
  status: SegmentJobStatus;
  createdAt: number;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  maxRetries: number;
  metadata: {
    batchId?: string;
    requestId?: string;
    userAgent?: string;
    source: string;
  };
  segment: Partial<Segment>;
  error?: {
    message: string;
    stack?: string;
    timestamp: number;
  };
}

export interface SegmentJobResult {
  jobId: string;
  segmentId: string;
  status: SegmentJobStatus;
  result?: {
    contactsAdded: number;
    contactsRemoved: number;
    totalContacts: number;
    processingTimeMs: number;
  };
  error?: {
    message: string;
    stack?: string;
    timestamp: number;
  };
  completedAt: number;
}

export interface BatchJobRequest {
  segments: Segment[];
  priority?: SegmentJobPriority;
  batchId?: string;
  requestId?: string;
  source: string;
}

@Injectable()
export class SegmentDistributedJobService {
  private readonly logger = new CustomLoggerService(
    SegmentDistributedJobService.name,
  );
  private readonly kafkaConfig = getSegmentKafkaConfig();

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly metrics: SegmentMetricsService,
  ) {
    this.logger.log('Segment distributed job service initialized');
  }

  /**
   * Create and enqueue a single segment computation job
   */
  async createSegmentJob(
    segment: Segment,
    priority: SegmentJobPriority = SegmentJobPriority.NORMAL,
    metadata: Partial<SegmentJob['metadata']> = {},
  ): Promise<SegmentJob> {
    const job: SegmentJob = {
      id: this.generateJobId(),
      segmentId: segment.id,
      priority,
      status: SegmentJobStatus.PENDING,
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: this.getMaxRetries(priority),
      metadata: {
        source: 'api',
        ...metadata,
      },
      segment: {
        id: segment.id,
        name: segment.name,
        definition: segment.definition,
        status: segment.status,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt,
      },
    };

    // Record job creation metrics
    this.metrics.recordSegmentComputationAttempt({
      segmentId: segment.id,
      operation: 'job_creation',
    });

    const topic = this.getTopicForPriority(priority);

    const eventData = {
      ...job,
      eventType: 'segment_computation_job',
      messageId: job.id,
      userId: job.segmentId,
    };

    await this.kafkaService.sendEvent(eventData);

    this.logger.debug(
      `Created job ${job.id} for segment ${segment.id} with priority ${priority}`,
    );

    return job;
  }

  /**
   * Create and enqueue multiple segment computation jobs as a batch
   */
  async createBatchJobs(request: BatchJobRequest): Promise<SegmentJob[]> {
    const batchId = request.batchId || this.generateBatchId();
    const jobs: SegmentJob[] = [];

    this.logger.log(
      `Creating batch job ${batchId} with ${request.segments.length} segments`,
    );

    // Record batch metrics
    this.metrics.recordBatchSize(request.segments.length);

    const batchJobs = await Promise.all(
      request.segments.map((segment) =>
        this.createSegmentJob(
          segment,
          request.priority || SegmentJobPriority.NORMAL,
          {
            batchId,
            requestId: request.requestId,
            source: request.source,
          },
        ),
      ),
    );

    jobs.push(...batchJobs);

    this.logger.debug(
      `Created ${batchJobs.length} jobs in batch ${batchId}`,
    );

    return jobs;
  }

  /**
   * Schedule a job for future execution
   */
  async scheduleSegmentJob(
    segment: Segment,
    scheduledAt: number,
    priority: SegmentJobPriority = SegmentJobPriority.NORMAL,
    metadata: Partial<SegmentJob['metadata']> = {},
  ): Promise<SegmentJob> {
    const job: SegmentJob = {
      id: this.generateJobId(),
      segmentId: segment.id,
      priority,
      status: SegmentJobStatus.PENDING,
      createdAt: Date.now(),
      scheduledAt,
      retryCount: 0,
      maxRetries: this.getMaxRetries(priority),
      metadata: {
        source: 'scheduler',
        ...metadata,
      },
      segment: {
        id: segment.id,
        name: segment.name,
        definition: segment.definition,
        status: segment.status,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt,
      },
    };

    const topic = this.getTopicForPriority(priority);

    const eventData = {
      ...job,
      eventType: 'segment_computation_job_scheduled',
      messageId: job.id,
      userId: job.segmentId,
      scheduledAt,
    };

    await this.kafkaService.sendEvent(eventData);

    this.logger.debug(
      `Scheduled job ${job.id} for segment ${segment.id} at ${new Date(scheduledAt).toISOString()}`,
    );

    return job;
  }

  /**
   * Retry a failed job
   */
  async retryJob(job: SegmentJob): Promise<SegmentJob> {
    if (job.retryCount >= job.maxRetries) {
      return this.moveToDeadLetter(job, new Error('Max retries exceeded'));
    }

    const retryJob: SegmentJob = {
      ...job,
      id: this.generateJobId(),
      status: SegmentJobStatus.RETRY,
      retryCount: job.retryCount + 1,
      createdAt: Date.now(),
      startedAt: undefined,
      completedAt: undefined,
    };

    this.metrics.recordSegmentComputationAttempt({
      segmentId: job.segmentId,
      operation: 'job_retry',
    });

    const topic = this.getTopicForPriority(job.priority);

    const eventData = {
      ...retryJob,
      eventType: 'segment_computation_job_retry',
      messageId: retryJob.id,
      userId: job.segmentId,
      originalJobId: job.id,
    };

    await this.kafkaService.sendEvent(eventData);

    this.logger.warn(
      `Retrying job ${job.id} as ${retryJob.id} (attempt ${retryJob.retryCount}/${retryJob.maxRetries})`,
    );

    return retryJob;
  }

  /**
   * Move a job to dead letter queue
   */
  async moveToDeadLetter(job: SegmentJob, error: Error): Promise<SegmentJob> {
    const dlqJob: SegmentJob = {
      ...job,
      status: SegmentJobStatus.DEAD_LETTER,
      error: {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
      },
      completedAt: Date.now(),
    };

    this.metrics.recordSegmentComputationFailure({
      segmentId: job.segmentId,
      operation: 'job_dead_letter',
      errorType: error.constructor.name,
    });

    const eventData = {
      ...dlqJob,
      eventType: 'segment_computation_job_dead_letter',
      messageId: job.id,
      userId: job.segmentId,
      errorType: error.constructor.name,
    };

    await this.kafkaService.sendEvent(eventData);

    this.logger.error(
      `Moved job ${job.id} to dead letter queue: ${error.message}`,
    );

    return dlqJob;
  }

  /**
   * Publish job result
   */
  async publishJobResult(result: SegmentJobResult): Promise<void> {
    if (result.status === SegmentJobStatus.COMPLETED) {
      this.metrics.recordSegmentComputationDuration(
        result.result?.processingTimeMs || 0,
        {
          segmentId: result.segmentId,
          status: 'success',
        },
      );
    } else {
      this.metrics.recordSegmentComputationFailure({
        segmentId: result.segmentId,
        operation: 'job_completion',
        errorType: result.error?.message || 'unknown',
      });
    }

    const eventData = {
      ...result,
      eventType: 'segment_computation_result',
      messageId: result.jobId,
      userId: result.segmentId,
    };

    await this.kafkaService.sendEvent(eventData);

    this.logger.debug(
      `Published result for job ${result.jobId} with status ${result.status}`,
    );
  }

  /**
   * Get job statistics for monitoring
   */
  async getJobStats(): Promise<{
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    deadLetter: number;
  }> {
    return {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
    };
  }

  // Private helper methods
  private generateJobId(): string {
    return `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateBatchId(): string {
    return `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getMaxRetries(priority: SegmentJobPriority): number {
    switch (priority) {
      case SegmentJobPriority.CRITICAL:
        return 5;
      case SegmentJobPriority.HIGH:
        return 4;
      case SegmentJobPriority.NORMAL:
        return 3;
      case SegmentJobPriority.LOW:
        return 2;
      default:
        return 3;
    }
  }

  private getTopicForPriority(
    priority: SegmentJobPriority,
  ): (typeof SEGMENT_KAFKA_TOPICS)[keyof typeof SEGMENT_KAFKA_TOPICS] {
    if (priority >= SegmentJobPriority.HIGH) {
      return SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_PRIORITY;
    }
    return SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_JOBS;
  }
}
