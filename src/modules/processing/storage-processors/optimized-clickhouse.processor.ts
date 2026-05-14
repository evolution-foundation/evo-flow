import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventData } from '../interfaces/event-data.interface';
import { ClickHousePool } from '../pools/clickhouse-pool';
import { BatchProcessor } from '../batch/batch-processor';
import {
  CircuitBreaker,
  CircuitBreakerState,
} from '../resilience/circuit-breaker';
import { BackpressureController } from '../resilience/backpressure-controller';
import { PrometheusMetrics } from '../metrics/prometheus-metrics';
import { getProcessingConfig } from '../config/processing.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface OptimizedClickHouseConfig {
  database: string;
  table: string;
  batchSize: number;
  batchTimeoutMs: number;
  maxMemoryMb: number;
  retries: number;
  compression: boolean;
  enableAsync: boolean;
}

@Injectable()
export class OptimizedClickHouseProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(
    OptimizedClickHouseProcessor.name,
  );
  private readonly config = getProcessingConfig();

  private pool: ClickHousePool;
  private batchProcessor: BatchProcessor;
  private circuitBreaker: CircuitBreaker;
  private backpressureController: BackpressureController;
  private metrics: PrometheusMetrics;

  private readonly chConfig: OptimizedClickHouseConfig;
  private processingStats = {
    totalEvents: 0,
    successfulBatches: 0,
    failedBatches: 0,
    avgBatchSize: 0,
    avgProcessingTime: 0,
  };

  constructor(metrics: PrometheusMetrics) {
    this.metrics = metrics;

    this.chConfig = {
      database: this.config.clickhouse?.database || 'evo_campaign',
      table: this.config.clickhouse?.table || 'contact_events',
      batchSize: 1000,
      batchTimeoutMs: 1000,
      maxMemoryMb: 100,
      retries: 3,
      compression: true,
      enableAsync: true,
    };

    this.logger.log(
      'Optimized ClickHouse processor initializing...',
      this.chConfig,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  private async initialize(): Promise<void> {
    try {
      // Initialize ClickHouse connection pool
      const protocol = this.config.clickhouse?.protocol || 'http';
      const host = this.config.clickhouse?.host || 'localhost';
      const port = this.config.clickhouse?.port || 8123;
      this.pool = new ClickHousePool(
        {
          host: `${protocol}://${host}:${port}`,
          username: this.config.clickhouse?.username || 'default',
          password: this.config.clickhouse?.password || '',
          database: this.chConfig.database,
          compression: {
            response: this.chConfig.compression,
            request: this.chConfig.compression,
          },
          max_open_connections: 10,
          request_timeout: 10000,
        },
        {
          min: 2,
          max: 10,
          acquireTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        },
      );

      // Initialize batch processor
      this.batchProcessor = new BatchProcessor({
        name: 'clickhouse-batch-processor',
        maxSize: this.chConfig.batchSize,
        maxWaitMs: this.chConfig.batchTimeoutMs,
        maxMemoryMb: this.chConfig.maxMemoryMb,
        processBatch: this.processBatch.bind(this),
      });

      // Initialize circuit breaker
      this.circuitBreaker = new CircuitBreaker('clickhouse-processor', {
        failureThreshold: 5,
        recoveryTimeout: 30000,
        monitoringPeriod: 60000,
        expectedFailureRate: 0.3,
        minimumThroughput: 10,
        timeout: 15000,
      });

      // Initialize backpressure controller
      this.backpressureController = new BackpressureController(
        'clickhouse-backpressure',
        {
          maxQueueSize: 50000,
          warningThreshold: 0.7,
          criticalThreshold: 0.85,
          recoveryThreshold: 0.5,
          checkIntervalMs: 1000,
          enableAutoScaling: true,
        },
      );

      // Setup event listeners
      this.setupEventListeners();

      this.logger.log(
        '✅ Optimized ClickHouse processor initialized successfully',
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize ClickHouse processor: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private setupEventListeners(): void {
    // Circuit breaker events
    this.circuitBreaker.on('opened', (data) => {
      this.logger.warn(`ClickHouse circuit breaker opened:`, data);
      this.metrics.updateCircuitBreakerMetrics(
        data.name,
        'open',
        data.failureCount,
        0,
      );
    });

    this.circuitBreaker.on('closed', (data) => {
      this.logger.log(`ClickHouse circuit breaker closed:`, data);
      this.metrics.updateCircuitBreakerMetrics(data.name, 'closed', 0, 0);
    });

    // Backpressure events
    this.backpressureController.on('stateChanged', (data) => {
      this.logger.log(
        `ClickHouse backpressure state changed: ${data.from} -> ${data.to}`,
      );
      this.metrics.updateQueueMetrics(
        'clickhouse',
        'processing',
        data.queueSize,
        data.utilization,
      );
    });

    this.backpressureController.on('requestDropped', (data) => {
      this.logger.warn(`ClickHouse request dropped due to backpressure:`, data);
    });

    // Pool events
    this.pool.on('clientCreated', () => {
      this.updatePoolMetrics();
    });

    this.pool.on('clientDestroyed', () => {
      this.updatePoolMetrics();
    });
  }

  async saveEvent(eventData: EventData): Promise<void> {
    const startTime = Date.now();

    try {
      // Check backpressure
      await this.backpressureController.checkCapacity();
      this.backpressureController.incrementQueue();

      // Add to batch processor
      const batchKey = this.getBatchKey(eventData);
      await this.batchProcessor.addEvent(eventData, batchKey);

      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordEventProcessed(
        eventData.eventType,
        'success',
        'batch',
        'clickhouse',
        duration,
      );

      this.processingStats.totalEvents++;
    } catch (error) {
      this.backpressureController.decrementQueue();

      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordEventProcessed(
        eventData.eventType,
        'error',
        'batch',
        'clickhouse',
        duration,
      );

      this.logger.error(`Failed to save event: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async processBatch(events: EventData[]): Promise<void> {
    const startTime = Date.now();
    const batchSize = events.length;

    this.logger.log(`Processing ClickHouse batch: ${batchSize} events`);

    try {
      // Execute batch insert through circuit breaker
      await this.circuitBreaker.execute(async () => {
        await this.insertBatch(events);
      });

      // Update queue size
      this.backpressureController.decrementQueue();

      // Record success metrics
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordBatchProcessed(
        'clickhouse',
        'clickhouse',
        batchSize,
        duration,
      );
      this.metrics.recordStorageOperation(
        'clickhouse',
        'batch_insert',
        'success',
        duration,
      );

      // Update stats
      this.processingStats.successfulBatches++;
      this.updateAverageStats(batchSize, duration);

      this.logger.log(
        `✅ Successfully processed ClickHouse batch: ${batchSize} events in ${duration.toFixed(3)}s`,
      );
    } catch (error) {
      // Update queue size
      this.backpressureController.decrementQueue();

      // Record error metrics
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordStorageOperation(
        'clickhouse',
        'batch_insert',
        'error',
        duration,
      );

      this.processingStats.failedBatches++;

      this.logger.error(
        `❌ Failed to process ClickHouse batch: ${batchSize} events - ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async insertBatch(events: EventData[]): Promise<void> {
    const client = await this.pool.acquire();

    try {
      // Prepare batch data
      const batchData = events.map((event) =>
        this.formatEventForClickHouse(event),
      );

      // Build insert query
      const insertQuery = this.buildBatchInsertQuery();

      // Execute batch insert
      const startTime = Date.now();

      if (this.chConfig.enableAsync) {
        // Use async insert for better performance
        await client.insert({
          table: `${this.chConfig.database}.${this.chConfig.table}`,
          values: batchData,
          format: 'JSONEachRow',
        });
      } else {
        // Use synchronous insert
        await client.insert({
          table: `${this.chConfig.database}.${this.chConfig.table}`,
          values: batchData,
          format: 'JSONEachRow',
        });
      }

      const insertTime = Date.now() - startTime;
      this.logger.debug(`ClickHouse batch insert completed in ${insertTime}ms`);
    } finally {
      await this.pool.release(client);
    }
  }

  private formatEventForClickHouse(event: EventData): any {
    const now = new Date();
    const occurredAt = event.timestamp ? new Date(event.timestamp) : now;

    return {
      contact_id: event.contactId || event.anonymousId || 'unknown',
      event_type: event.eventType,
      event_name: event.eventName || event.eventType,
      properties: JSON.stringify(event.properties || {}),
      traits: JSON.stringify(event.traits || {}),
      anonymous_id: event.anonymousId,
      message_id: event.messageId,
      occurred_at: occurredAt.toISOString(),
      processing_time: now.toISOString(),
      message_raw: JSON.stringify(event),
      contact_or_anonymous_id:
        event.contactId || event.anonymousId || 'unknown',
    };
  }

  private buildBatchInsertQuery(): string {
    return `
      INSERT INTO ${this.chConfig.database}.${this.chConfig.table} (
        contact_id, event_type, event_name,
        properties, traits, anonymous_id, message_id,
        occurred_at, processing_time, message_raw, contact_or_anonymous_id
      ) VALUES
    `;
  }

  private getBatchKey(_event: EventData): string {
    // Single-account: all events share one batch key
    return 'default';
  }

  private updateAverageStats(batchSize: number, duration: number): void {
    const totalBatches = this.processingStats.successfulBatches;

    // Update running averages
    this.processingStats.avgBatchSize =
      (this.processingStats.avgBatchSize * (totalBatches - 1) + batchSize) /
      totalBatches;

    this.processingStats.avgProcessingTime =
      (this.processingStats.avgProcessingTime * (totalBatches - 1) + duration) /
      totalBatches;
  }

  private updatePoolMetrics(): void {
    const poolStats = this.pool.getStats();
    this.metrics.updateConnectionPoolMetrics(
      'clickhouse',
      poolStats.available,
      poolStats.borrowed,
      poolStats.pending,
      poolStats.invalid,
    );
  }

  // Monitoring and health check methods
  async healthCheck(): Promise<boolean> {
    try {
      if (this.circuitBreaker.getStats().state === CircuitBreakerState.OPEN) {
        return false;
      }

      const client = await this.pool.acquire();
      try {
        await client.ping();
        return true;
      } finally {
        await this.pool.release(client);
      }
    } catch (error) {
      this.logger.error(`ClickHouse health check failed: ${error.message}`);
      return false;
    }
  }

  getStats() {
    return {
      processing: this.processingStats,
      batch: this.batchProcessor.getStats(),
      pool: this.pool.getStats(),
      circuitBreaker: this.circuitBreaker.getStats(),
      backpressure: this.backpressureController.getStats(),
      config: this.chConfig,
    };
  }

  async flushPendingBatches(): Promise<void> {
    this.logger.log('Flushing all pending ClickHouse batches...');
    await this.batchProcessor.flushAll();
  }

  // Manual controls
  pauseProcessing(): void {
    this.backpressureController.pause();
    this.logger.log('ClickHouse processing paused');
  }

  resumeProcessing(): void {
    this.backpressureController.resume();
    this.logger.log('ClickHouse processing resumed');
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
    this.logger.log('ClickHouse circuit breaker reset');
  }

  private async shutdown(): Promise<void> {
    this.logger.log('Shutting down optimized ClickHouse processor...');

    try {
      // Flush pending batches
      await this.flushPendingBatches();

      // Shutdown components
      if (this.batchProcessor) {
        await this.batchProcessor.onModuleDestroy();
      }

      if (this.backpressureController) {
        this.backpressureController.destroy();
      }

      if (this.pool) {
        await this.pool.onModuleDestroy();
      }

      this.logger.log('✅ Optimized ClickHouse processor shutdown complete');
    } catch (error) {
      this.logger.error(
        `Error during ClickHouse processor shutdown: ${error.message}`,
        error.stack,
      );
    }
  }
}
