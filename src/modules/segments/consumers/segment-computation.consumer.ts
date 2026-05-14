import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Consumer, EachMessagePayload } from 'kafkajs';
import { KafkaDistributedService } from '../services/kafka-distributed.service';
import { ModularSegmentComputationService } from '../services/modular-segment-computation.service';
import {
  SegmentDistributedJobService,
  SegmentJob,
  SegmentJobResult,
} from '../services/segment-distributed-job.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import { SegmentCircuitBreakerService } from '../services/segment-circuit-breaker.service';
import {
  SEGMENT_KAFKA_TOPICS,
  SEGMENT_CONSUMER_GROUPS,
  SegmentJobStatus,
  getSegmentKafkaConfig,
} from '../config/kafka-topics.config';
import { Segment } from '../entities/segment.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class SegmentComputationConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(
    SegmentComputationConsumer.name,
  );
  private readonly kafkaConfig = getSegmentKafkaConfig();
  private consumer: Consumer;
  private priorityConsumer: Consumer;
  private isRunning = false;

  constructor(
    private readonly kafkaDistributedService: KafkaDistributedService,
    private readonly segmentComputation: ModularSegmentComputationService,
    private readonly jobService: SegmentDistributedJobService,
    private readonly metrics: SegmentMetricsService,
    private readonly circuitBreaker: SegmentCircuitBreakerService,
  ) {}

  async onModuleInit() {
    if (process.env.ENABLE_DISTRIBUTED_PROCESSING !== 'true') {
      this.logger.log(
        'Distributed processing disabled, skipping consumer initialization',
      );
      return;
    }

    this.logger.log('Starting segment computation consumer initialization...');

    try {
      await this.initializeConsumers();
      await this.startConsumers();
      this.logger.log(
        '✅ Segment computation consumers fully initialized and running',
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize segment computation consumer: ${error.message}`,
        error.stack,
      );
      // Don't throw - let the application start even if Kafka is not available
    }
  }

  async onModuleDestroy() {
    await this.stopConsumers();
  }

  private async initializeConsumers() {
    try {
      // Create regular computation consumer with optimized settings for immediate processing
      this.consumer = await this.kafkaDistributedService.createTopicConsumer(
        SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_JOBS.name,
        SEGMENT_CONSUMER_GROUPS.COMPUTATION_WORKERS,
        async (payload: EachMessagePayload) => {
          await this.processMessage(payload, 'regular');
        },
        {
          sessionTimeout: 30000, // 30s - within Kafka broker limits (min: 6s, max: 5min)
          heartbeatInterval: 3000, // Must be <= 1/3 of sessionTimeout (Kafka requirement)
          maxBytesPerPartition: 10485760, // 10MB for large segments
          fromBeginning: false, // Only process new messages
        },
      );

      // Create priority computation consumer with optimized settings for immediate processing
      this.priorityConsumer =
        await this.kafkaDistributedService.createTopicConsumer(
          SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_PRIORITY.name,
          SEGMENT_CONSUMER_GROUPS.PRIORITY_WORKERS,
          async (payload: EachMessagePayload) => {
            await this.processMessage(payload, 'priority');
          },
          {
            sessionTimeout: 18000, // 18s - within Kafka broker limits (min: 6s, max: 5min)
            heartbeatInterval: 3000, // Must be <= 1/3 of sessionTimeout (Kafka requirement)
            maxBytesPerPartition: 10485760, // 10MB for large segments
            fromBeginning: false, // Only process new messages
          },
        );

      this.logger.log(
        '✅ Distributed Kafka consumers initialized for segment computation',
      );
    } catch (error) {
      this.logger.warn(
        `Could not initialize Kafka consumers: ${error.message}`,
      );
      // Continue without Kafka consumers if they can't be created
    }
  }

  private async startConsumers() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('Segment computation consumers started');
  }

  private async stopConsumers() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.logger.log('Segment computation consumers stopped');
  }

  private async processMessage(
    payload: EachMessagePayload,
    consumerType: 'regular' | 'priority',
  ) {
    const { message, topic, partition } = payload;
    const startTime = Date.now();

    try {
      // Parse job from message
      const job: SegmentJob = JSON.parse(message.value?.toString() || '{}');

      // Validate job
      if (!this.isValidJob(job)) {
        this.logger.error(`Invalid job received: ${message.value?.toString()}`);
        return;
      }

      // Check if job is scheduled for future execution
      if (job.scheduledAt && job.scheduledAt > Date.now()) {
        this.logger.debug(
          `Job ${job.id} scheduled for future, skipping for now`,
        );
        return;
      }

      this.logger.log(
        `🚀 IMMEDIATELY processing job ${job.id} for segment ${job.segmentId} (${consumerType} consumer, partition ${partition})`,
      );

      // Update job status to processing
      const processingJob: SegmentJob = {
        ...job,
        status: SegmentJobStatus.PROCESSING,
        startedAt: Date.now(),
      };

      // Record processing metrics
      this.metrics.recordSegmentComputationAttempt({
        segmentId: job.segmentId,
        operation: 'job_processing',
      });

      // Execute computation with circuit breaker protection
      const result = await this.circuitBreaker.execute(async () => {
        // Convert job segment data to Segment entity
        const segment = this.jobToSegment(job);
        return await this.segmentComputation.computeSegment(segment);
      }, `job-computation-${job.id}`);

      // Create successful result
      const jobResult: SegmentJobResult = {
        jobId: job.id,
        segmentId: job.segmentId,
        status: SegmentJobStatus.COMPLETED,
        result: {
          contactsAdded: result.contactsAdded,
          contactsRemoved: result.contactsRemoved,
          totalContacts: result.totalContacts,
          processingTimeMs: result.processingTimeMs,
        },
        completedAt: Date.now(),
      };

      // Publish result
      await this.jobService.publishJobResult(jobResult);

      this.logger.log(
        `Completed job ${job.id} for segment ${job.segmentId} in ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      await this.handleJobError(payload, error as Error, startTime);
    }
  }

  private async handleJobError(
    payload: EachMessagePayload,
    error: Error,
    startTime: number,
  ) {
    const { message } = payload;

    try {
      const job: SegmentJob = JSON.parse(message.value?.toString() || '{}');

      this.logger.error(
        `Error processing job ${job.id}: ${error.message}`,
        error.stack,
      );

      // Check if we should retry
      if (job.retryCount < job.maxRetries) {
        await this.jobService.retryJob(job);
      } else {
        await this.jobService.moveToDeadLetter(job, error);
      }

      // Create failed result
      const jobResult: SegmentJobResult = {
        jobId: job.id,
        segmentId: job.segmentId,
        status: SegmentJobStatus.FAILED,
        error: {
          message: error.message,
          stack: error.stack,
          timestamp: Date.now(),
        },
        completedAt: Date.now(),
      };

      // Publish result
      await this.jobService.publishJobResult(jobResult);
    } catch (parseError) {
      this.logger.error(
        `Failed to handle job error - could not parse message: ${parseError}`,
      );
    }
  }

  private isValidJob(job: any): job is SegmentJob {
    return (
      job &&
      typeof job === 'object' &&
      typeof job.id === 'string' &&
      typeof job.segmentId === 'string' &&
      job.segment &&
      typeof job.segment === 'object'
    );
  }

  private jobToSegment(job: SegmentJob): Segment {
    // Create a Segment entity from job data
    const segment = new Segment();
    segment.id = job.segment.id || job.segmentId;
    segment.name = job.segment.name || `Segment ${job.segmentId}`;
    segment.definition = job.segment.definition || ({} as any);
    segment.status = 'running'; // Default status
    segment.createdAt = job.segment.createdAt
      ? new Date(job.segment.createdAt)
      : new Date();
    segment.updatedAt = job.segment.updatedAt
      ? new Date(job.segment.updatedAt)
      : new Date();

    return segment;
  }

  /**
   * Get consumer health status
   */
  getHealthStatus(): {
    isRunning: boolean;
    consumers: {
      regular: boolean;
      priority: boolean;
    };
  } {
    return {
      isRunning: this.isRunning,
      consumers: {
        regular: this.isRunning,
        priority: this.isRunning,
      },
    };
  }

  /**
   * Get consumer metrics
   */
  async getConsumerMetrics(): Promise<{
    messagesProcessed: number;
    averageProcessingTime: number;
    errorRate: number;
  }> {
    // In a real implementation, you would track these metrics
    return {
      messagesProcessed: 0,
      averageProcessingTime: 0,
      errorRate: 0,
    };
  }
}
