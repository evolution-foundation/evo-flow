import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Consumer, EachMessagePayload } from 'kafkajs';
import { KafkaDistributedService } from '../services/kafka-distributed.service';
import { SegmentJobResult } from '../services/segment-distributed-job.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import {
  SEGMENT_KAFKA_TOPICS,
  SEGMENT_CONSUMER_GROUPS,
  SegmentJobStatus,
  getSegmentKafkaConfig,
} from '../config/kafka-topics.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface ResultProcessingEvent {
  type: 'segment_computation_completed' | 'segment_computation_failed';
  jobId: string;
  segmentId: string;
  result?: {
    contactsAdded: number;
    contactsRemoved: number;
    totalContacts: number;
    processingTimeMs: number;
  };
  error?: {
    message: string;
    timestamp: number;
  };
  timestamp: number;
}

@Injectable()
export class SegmentResultsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    SegmentResultsConsumer.name,
  );
  private readonly kafkaConfig = getSegmentKafkaConfig();
  private consumer: Consumer;
  private isRunning = false;

  // In-memory store for results (in production, use Redis or database)
  private recentResults = new Map<string, SegmentJobResult>();
  private readonly MAX_RESULTS_CACHE = 1000;

  constructor(
    private readonly kafkaDistributedService: KafkaDistributedService,
    private readonly metrics: SegmentMetricsService,
  ) {}

  async onModuleInit() {
    try {
      await this.initializeConsumer();
      await this.startConsumer();
    } catch (error) {
      this.logger.error(
        `Failed to initialize segment results consumer: ${error.message}`,
      );
      // Don't throw - let the application start even if Kafka is not available
    }
  }

  async onModuleDestroy() {
    await this.stopConsumer();
  }

  private async initializeConsumer() {
    try {
      // Create results consumer for distributed processing
      this.consumer = await this.kafkaDistributedService.createTopicConsumer(
        SEGMENT_KAFKA_TOPICS.SEGMENT_RESULTS.name,
        SEGMENT_CONSUMER_GROUPS.RESULT_PROCESSORS,
        async (payload: EachMessagePayload) => {
          await this.processResult(payload);
        },
      );

      this.logger.log('✅ Distributed results consumer initialized');
    } catch (error) {
      this.logger.warn(
        `Could not initialize Kafka results consumer: ${error.message}`,
      );
      // Continue without Kafka consumer if it can't be created
    }
  }

  private async startConsumer() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('Results consumer started');
  }

  private async stopConsumer() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.logger.log('Results consumer stopped');
  }

  private async processResult(payload: EachMessagePayload) {
    const { message, topic, partition } = payload;
    const processStartTime = Date.now();

    try {
      const result: SegmentJobResult = JSON.parse(
        message.value?.toString() || '{}',
      );

      if (!this.isValidResult(result)) {
        this.logger.error(
          `Invalid result received: ${message.value?.toString()}`,
        );
        return;
      }

      this.logger.debug(
        `Processing result for job ${result.jobId}, segment ${result.segmentId}, status: ${result.status}`,
      );

      // Store result in cache
      this.cacheResult(result);

      // Process based on status
      switch (result.status) {
        case SegmentJobStatus.COMPLETED:
          await this.handleSuccessfulResult(result);
          break;
        case SegmentJobStatus.FAILED:
          await this.handleFailedResult(result);
          break;
        default:
          this.logger.warn(`Unknown result status: ${result.status}`);
      }

      // Record result processing metrics
      this.metrics.recordSegmentComputationAttempt({
        segmentId: result.segmentId,
        operation: 'result_processing',
      });

      this.logger.debug(
        `Processed result for job ${result.jobId} in ${Date.now() - processStartTime}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing result: ${(error as Error).message}`,
        (error as Error).stack,
      );

      // Record result processing failure
      this.metrics.recordSegmentComputationFailure({
        segmentId: 'unknown',
        operation: 'result_processing',
        errorType: (error as Error).constructor.name,
      });
    }
  }

  private async handleSuccessfulResult(result: SegmentJobResult) {
    if (!result.result) {
      this.logger.warn(`Successful result ${result.jobId} missing result data`);
      return;
    }

    // Create success event
    const event: ResultProcessingEvent = {
      type: 'segment_computation_completed',
      jobId: result.jobId,
      segmentId: result.segmentId,
      result: result.result,
      timestamp: result.completedAt,
    };

    // In a real implementation, you might:
    // 1. Update segment assignments in database
    // 2. Send notifications to frontend clients via WebSocket
    // 3. Trigger downstream processes (campaigns, analytics)
    // 4. Update segment cache
    // 5. Log for audit purposes

    this.logger.log(
      `Segment ${result.segmentId} computation completed successfully: ` +
        `+${result.result.contactsAdded} contacts, -${result.result.contactsRemoved} contacts, ` +
        `total: ${result.result.totalContacts} contacts in ${result.result.processingTimeMs}ms`,
    );

    // Emit event (placeholder - in production, use event bus)
    await this.emitEvent(event);
  }

  private async handleFailedResult(result: SegmentJobResult) {
    // Create failure event
    const event: ResultProcessingEvent = {
      type: 'segment_computation_failed',
      jobId: result.jobId,
      segmentId: result.segmentId,
      error: result.error
        ? {
            message: result.error.message,
            timestamp: result.error.timestamp,
          }
        : undefined,
      timestamp: result.completedAt,
    };

    this.logger.error(
      `Segment ${result.segmentId} computation failed for job ${result.jobId}: ${result.error?.message}`,
    );

    // Emit event (placeholder - in production, use event bus)
    await this.emitEvent(event);
  }

  private isValidResult(result: any): result is SegmentJobResult {
    return (
      result &&
      typeof result === 'object' &&
      typeof result.jobId === 'string' &&
      typeof result.segmentId === 'string' &&
      typeof result.status === 'string' &&
      typeof result.completedAt === 'number'
    );
  }

  private cacheResult(result: SegmentJobResult) {
    // Add to cache
    this.recentResults.set(result.jobId, result);

    // Cleanup old entries if cache is full
    if (this.recentResults.size > this.MAX_RESULTS_CACHE) {
      // Remove oldest entries (simple FIFO)
      const oldestKeys = Array.from(this.recentResults.keys()).slice(0, 100);
      oldestKeys.forEach((key) => this.recentResults.delete(key));
    }
  }

  private async emitEvent(event: ResultProcessingEvent) {
    // Placeholder for event emission
    // In production, you would emit to an event bus, WebSocket connections, etc.
    this.logger.debug(
      `Event emitted: ${event.type} for segment ${event.segmentId}`,
    );
  }

  /**
   * Get recent results for monitoring
   */
  getRecentResults(limit: number = 10): SegmentJobResult[] {
    const results = Array.from(this.recentResults.values());
    return results
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, limit);
  }

  /**
   * Get result by job ID
   */
  getResultByJobId(jobId: string): SegmentJobResult | undefined {
    return this.recentResults.get(jobId);
  }

  /**
   * Get results summary
   */
  getResultsSummary(): {
    total: number;
    completed: number;
    failed: number;
    averageProcessingTime: number;
  } {
    const allResults = Array.from(this.recentResults.values());

    const completed = allResults.filter(
      (r) => r.status === SegmentJobStatus.COMPLETED,
    );
    const failed = allResults.filter(
      (r) => r.status === SegmentJobStatus.FAILED,
    );

    const totalProcessingTime = completed
      .filter((r) => r.result?.processingTimeMs)
      .reduce((sum, r) => sum + (r.result?.processingTimeMs || 0), 0);

    return {
      total: allResults.length,
      completed: completed.length,
      failed: failed.length,
      averageProcessingTime:
        completed.length > 0 ? totalProcessingTime / completed.length : 0,
    };
  }

  /**
   * Get consumer health status
   */
  getHealthStatus(): {
    isRunning: boolean;
    cacheSize: number;
    maxCacheSize: number;
  } {
    return {
      isRunning: this.isRunning,
      cacheSize: this.recentResults.size,
      maxCacheSize: this.MAX_RESULTS_CACHE,
    };
  }
}
