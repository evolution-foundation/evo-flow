import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventData } from '../interfaces/event-data.interface';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface BatchConfig {
  maxSize: number;
  maxWaitMs: number;
  maxMemoryMb: number;
}

export interface BatchProcessorOptions extends BatchConfig {
  processBatch: (events: EventData[]) => Promise<void>;
  name: string;
}

@Injectable()
export class BatchProcessor implements OnModuleDestroy {
  private readonly logger = new CustomLoggerService(BatchProcessor.name);
  private batches = new Map<string, EventData[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private memoryUsage = 0;
  private isShuttingDown = false;

  private readonly config: BatchConfig;
  private readonly processBatch: (events: EventData[]) => Promise<void>;
  private readonly name: string;

  constructor(options: BatchProcessorOptions) {
    this.config = {
      maxSize: options.maxSize,
      maxWaitMs: options.maxWaitMs,
      maxMemoryMb: options.maxMemoryMb,
    };
    this.processBatch = options.processBatch;
    this.name = options.name;

    this.logger.log(`Batch processor initialized: ${this.name}`);
    this.logger.log(
      `Config: maxSize=${this.config.maxSize}, maxWait=${this.config.maxWaitMs}ms`,
    );
  }

  async addEvent(
    event: EventData,
    batchKey: string = 'default',
  ): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('BatchProcessor is shutting down');
    }

    // Memory pressure check
    const eventSize = this.estimateEventSize(event);
    if (this.memoryUsage + eventSize > this.config.maxMemoryMb * 1024 * 1024) {
      this.logger.warn(`Memory pressure detected, flushing batch: ${batchKey}`);
      await this.flushBatch(batchKey);
    }

    // Initialize batch if needed
    if (!this.batches.has(batchKey)) {
      this.batches.set(batchKey, []);
    }

    const batch = this.batches.get(batchKey)!;
    batch.push(event);
    this.memoryUsage += eventSize;

    this.logger.debug(
      `Added event to batch ${batchKey}: ${batch.length}/${this.config.maxSize}`,
    );

    // Check if batch is full
    if (batch.length >= this.config.maxSize) {
      this.logger.debug(`Batch ${batchKey} is full, flushing immediately`);
      await this.flushBatch(batchKey);
      return;
    }

    // Set/reset flush timer
    this.resetFlushTimer(batchKey);
  }

  private resetFlushTimer(batchKey: string): void {
    // Clear existing timer
    const existingTimer = this.timers.get(batchKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      this.logger.debug(`Batch ${batchKey} timer expired, flushing`);
      try {
        await this.flushBatch(batchKey);
      } catch (error) {
        this.logger.error(
          `Failed to flush batch ${batchKey} on timer: ${error.message}`,
        );
      }
    }, this.config.maxWaitMs);

    this.timers.set(batchKey, timer);
  }

  async flushBatch(batchKey: string): Promise<void> {
    const batch = this.batches.get(batchKey);
    if (!batch || batch.length === 0) {
      return;
    }

    // Clear timer
    const timer = this.timers.get(batchKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(batchKey);
    }

    // Take ownership of batch
    const eventsToProcess = [...batch];
    this.batches.set(batchKey, []);

    // Update memory usage
    const batchMemory = eventsToProcess.reduce(
      (sum, event) => sum + this.estimateEventSize(event),
      0,
    );
    this.memoryUsage = Math.max(0, this.memoryUsage - batchMemory);

    this.logger.log(
      `Flushing batch ${batchKey}: ${eventsToProcess.length} events`,
    );

    try {
      await this.processBatch(eventsToProcess);
      this.logger.log(
        `✅ Successfully processed batch ${batchKey}: ${eventsToProcess.length} events`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to process batch ${batchKey}: ${error.message}`,
        error.stack,
      );

      // Re-add events to batch for retry (with exponential backoff)
      const currentBatch = this.batches.get(batchKey) || [];
      this.batches.set(batchKey, [...eventsToProcess, ...currentBatch]);
      this.memoryUsage += batchMemory;

      throw error;
    }
  }

  async flushAll(): Promise<void> {
    this.logger.log('Flushing all batches...');

    const flushPromises = Array.from(this.batches.keys()).map(
      async (batchKey) => {
        try {
          await this.flushBatch(batchKey);
        } catch (error) {
          this.logger.error(
            `Failed to flush batch ${batchKey}: ${error.message}`,
          );
        }
      },
    );

    await Promise.all(flushPromises);
    this.logger.log('All batches flushed');
  }

  private estimateEventSize(event: EventData): number {
    // Rough estimation of event size in bytes
    const json = JSON.stringify(event);
    return Buffer.byteLength(json, 'utf8');
  }

  getStats() {
    const batchStats = Array.from(this.batches.entries()).map(
      ([key, batch]) => ({
        key,
        size: batch.length,
        memoryBytes: batch.reduce(
          (sum, event) => sum + this.estimateEventSize(event),
          0,
        ),
      }),
    );

    return {
      name: this.name,
      totalBatches: this.batches.size,
      totalEvents: Array.from(this.batches.values()).reduce(
        (sum, batch) => sum + batch.length,
        0,
      ),
      memoryUsageMb: Math.round((this.memoryUsage / 1024 / 1024) * 100) / 100,
      batches: batchStats,
      config: this.config,
    };
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down batch processor...');
    this.isShuttingDown = true;

    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Flush all pending batches
    try {
      await this.flushAll();
    } catch (error) {
      this.logger.error(`Error during shutdown: ${error.message}`);
    }

    this.logger.log('Batch processor shutdown complete');
  }
}
