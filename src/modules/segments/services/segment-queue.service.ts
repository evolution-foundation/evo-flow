import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Segment } from '../entities/segment.entity';
import { ModularSegmentComputationService } from './modular-segment-computation.service';
import { RunMode } from '../../processing/enums/run-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentQueueItem {
  id: string;
  segmentId: string;
  priority: number;
  insertedAt: number;
  type: 'segment';
}

export interface SegmentQueueState {
  priorityQueue: SegmentQueueItem[];
  membership: Set<string>;
  inFlightSegments: Set<string>;
  totalProcessed: number;
}

@Injectable()
export class SegmentQueueService {
  private readonly logger = new CustomLoggerService(SegmentQueueService.name);
  private readonly queueState: SegmentQueueState = {
    priorityQueue: [],
    membership: new Set(),
    inFlightSegments: new Set(),
    totalProcessed: 0,
  };

  // Configuration (similar to Dittofeed)
  private readonly maxConcurrency = 3;
  private readonly maxCapacity = 100;
  private readonly processingInterval = 1000; // 1 second
  private processingTimer?: NodeJS.Timeout;
  private readonly runMode: RunMode;

  constructor(
    @InjectRepository(Segment)
    private segmentRepository: Repository<Segment>,
    private modularSegmentComputationService: ModularSegmentComputationService,
    private configService: ConfigService,
  ) {
    this.runMode = this.configService.get<RunMode>('RUN_MODE', RunMode.SINGLE);

    // Only start processing in appropriate modes
    if (this.isSegmentProcessingEnabled()) {
      this.startProcessing();
    } else {
      this.logger.log(
        `🎯 Segment queue processing: DISABLED (${this.runMode} mode)`,
      );
    }
  }

  private isSegmentProcessingEnabled(): boolean {
    return (
      this.runMode === RunMode.SINGLE || this.runMode === RunMode.SEGMENT_WORKER
    );
  }

  /**
   * Enqueue segments for recomputation (Dittofeed-style)
   */
  async enqueueSegments(items: {
    segmentIds: string[];
    priority?: number;
  }): Promise<void> {
    const { segmentIds, priority = 1 } = items;
    const now = Date.now();

    for (const segmentId of segmentIds) {
      const key = this.generateKey(segmentId);

      // Deduplicate - don't add if already in queue or processing
      if (
        this.queueState.membership.has(key) ||
        this.queueState.inFlightSegments.has(key)
      ) {
        this.logger.debug(
          `Segment ${segmentId} already queued or processing, skipping`,
        );
        continue;
      }

      // Check capacity
      if (this.queueState.priorityQueue.length >= this.maxCapacity) {
        this.logger.warn(
          `Queue at capacity (${this.maxCapacity}), dropping segment ${segmentId}`,
        );
        continue;
      }

      const queueItem: SegmentQueueItem = {
        id: key,
        segmentId,
        priority,
        insertedAt: now,
        type: 'segment',
      };

      this.queueState.priorityQueue.push(queueItem);
      this.queueState.membership.add(key);

      this.logger.debug(
        `Enqueued segment ${segmentId} with priority ${priority}`,
      );
    }

    // Sort by priority (higher priority first, then by insertion time)
    this.queueState.priorityQueue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return a.insertedAt - b.insertedAt; // Earlier insertion first
    });

    this.logger.debug(
      `Queue state: ${this.queueState.priorityQueue.length} items, ` +
        `${this.queueState.inFlightSegments.size} in-flight`,
    );
  }

  /**
   * Start the processing loop (similar to Dittofeed's queue workflow)
   */
  private startProcessing(): void {
    this.processingTimer = setInterval(async () => {
      await this.processQueue();
    }, this.processingInterval);

    this.logger.log('🚀 Segment queue processing started');
  }

  /**
   * Process the queue (Dittofeed-style streaming concurrency)
   */
  private async processQueue(): Promise<void> {
    // Check if we can process more items
    if (this.queueState.inFlightSegments.size >= this.maxConcurrency) {
      return; // Wait for in-flight items to complete
    }

    // Get next item from queue
    if (this.queueState.priorityQueue.length === 0) {
      return; // Queue is empty
    }

    const item = this.queueState.priorityQueue.shift()!;
    const key = item.id;

    // Mark as in-flight
    this.queueState.inFlightSegments.add(key);
    this.queueState.membership.delete(key);

    this.logger.debug(
      `Processing segment ${item.segmentId} ` +
        `(priority: ${item.priority}, queue size: ${this.queueState.priorityQueue.length})`,
    );

    // Process in background (don't await)
    this.processSegmentItem(item).finally(() => {
      this.queueState.inFlightSegments.delete(key);
      this.queueState.totalProcessed++;
    });
  }

  /**
   * Process individual segment item (Dittofeed-style)
   */
  private async processSegmentItem(item: SegmentQueueItem): Promise<void> {
    const startTime = Date.now();

    try {
      // Get segment from database
      const segment = await this.segmentRepository.findOne({
        where: {
          id: item.segmentId,
        },
      });

      if (!segment) {
        this.logger.warn(`Segment ${item.segmentId} not found, skipping`);
        return;
      }

      // Use new modular computation service
      await this.modularSegmentComputationService.computeSegment(segment);

      const duration = Date.now() - startTime;
      this.logger.debug(
        `✅ Processed segment ${item.segmentId} in ${duration}ms`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `❌ Failed to process segment ${item.segmentId} after ${duration}ms: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Generate unique key for segment (Dittofeed-style)
   */
  private generateKey(segmentId: string): string {
    return `segment:${segmentId}`;
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): {
    queueSize: number;
    inFlightCount: number;
    totalProcessed: number;
    membershipSize: number;
  } {
    return {
      queueSize: this.queueState.priorityQueue.length,
      inFlightCount: this.queueState.inFlightSegments.size,
      totalProcessed: this.queueState.totalProcessed,
      membershipSize: this.queueState.membership.size,
    };
  }

  /**
   * Cleanup on module destroy
   */
  onModuleDestroy(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.logger.log('🛑 Segment queue processing stopped');
    }
  }
}
