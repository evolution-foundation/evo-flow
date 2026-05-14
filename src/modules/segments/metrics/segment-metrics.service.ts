import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

// Interface for Prometheus-compatible metrics (will work with @nestjs/prometheus if available)
interface PrometheusMetric {
  inc(labels?: Record<string, string | number>, value?: number): void;
  observe?(labels?: Record<string, string | number>, value?: number): void;
  set?(labels?: Record<string, string | number>, value?: number): void;
}

// Simple in-memory metrics implementation (can be replaced with real Prometheus later)
class InMemoryCounter implements PrometheusMetric {
  private values = new Map<string, number>();

  inc(labels: Record<string, string | number> = {}, value: number = 1): void {
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  getValue(labels: Record<string, string | number> = {}): number {
    return this.values.get(this.getKey(labels)) || 0;
  }

  private getKey(labels: Record<string, string | number>): string {
    return JSON.stringify(labels);
  }
}

class InMemoryHistogram implements PrometheusMetric {
  private values = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();

  inc(): void {
    // Not used for histograms
  }

  observe(labels: Record<string, string | number> = {}, value: number): void {
    const key = this.getKey(labels);

    // Store individual values
    const values = this.values.get(key) || [];
    values.push(value);
    this.values.set(key, values);

    // Update sum and count
    const currentSum = this.sums.get(key) || 0;
    const currentCount = this.counts.get(key) || 0;

    this.sums.set(key, currentSum + value);
    this.counts.set(key, currentCount + 1);
  }

  getMetrics(labels: Record<string, string | number> = {}) {
    const key = this.getKey(labels);
    const values = this.values.get(key) || [];
    const sum = this.sums.get(key) || 0;
    const count = this.counts.get(key) || 0;

    if (count === 0) {
      return { count: 0, sum: 0, avg: 0, p95: 0, p99: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      count,
      sum,
      avg: sum / count,
      p95: sorted[p95Index] || 0,
      p99: sorted[p99Index] || 0,
    };
  }

  private getKey(labels: Record<string, string | number>): string {
    return JSON.stringify(labels);
  }
}

@Injectable()
export class SegmentMetricsService {
  private readonly logger = new CustomLoggerService(SegmentMetricsService.name);

  // Metrics
  private readonly segmentComputationDuration: InMemoryHistogram;
  private readonly segmentComputationTotal: InMemoryCounter;
  private readonly segmentComputationFailures: InMemoryCounter;
  private readonly deletedContactsCacheHits: InMemoryCounter;
  private readonly deletedContactsCacheMisses: InMemoryCounter;
  private readonly segmentBatchSize: InMemoryHistogram;

  constructor() {
    // Initialize metrics
    this.segmentComputationDuration = new InMemoryHistogram();
    this.segmentComputationTotal = new InMemoryCounter();
    this.segmentComputationFailures = new InMemoryCounter();
    this.deletedContactsCacheHits = new InMemoryCounter();
    this.deletedContactsCacheMisses = new InMemoryCounter();
    this.segmentBatchSize = new InMemoryHistogram();

    this.logger.log('Segment metrics service initialized');
  }

  recordSegmentComputationDuration(
    durationMs: number,
    labels: {
      segmentId: string;
      status: 'success' | 'failure';
    },
  ): void {
    this.segmentComputationDuration.observe(labels, durationMs);
  }

  recordSegmentComputationAttempt(labels: {
    segmentId?: string;
    operation: string;
  }): void {
    this.segmentComputationTotal.inc(labels);
  }

  recordSegmentComputationFailure(labels: {
    segmentId?: string;
    operation: string;
    errorType: string;
  }): void {
    this.segmentComputationFailures.inc(labels);
  }

  recordCacheHit(): void {
    this.deletedContactsCacheHits.inc({});
  }

  recordCacheMiss(): void {
    this.deletedContactsCacheMisses.inc({});
  }

  recordBatchSize(batchSize: number): void {
    this.segmentBatchSize.observe({}, batchSize);
  }

  // Get metrics for monitoring/health endpoints
  getMetricsSummary() {
    const computationMetrics = this.segmentComputationDuration.getMetrics();
    const batchMetrics = this.segmentBatchSize.getMetrics();

    const totalComputations = this.segmentComputationTotal.getValue();
    const totalFailures = this.segmentComputationFailures.getValue();
    const successRate =
      totalComputations > 0
        ? ((totalComputations - totalFailures) / totalComputations) * 100
        : 100;

    const totalCacheHits = this.deletedContactsCacheHits.getValue();
    const totalCacheMisses = this.deletedContactsCacheMisses.getValue();
    const totalCacheRequests = totalCacheHits + totalCacheMisses;
    const cacheHitRatio =
      totalCacheRequests > 0 ? (totalCacheHits / totalCacheRequests) * 100 : 0;

    return {
      segment_computation: {
        total_requests: totalComputations,
        total_failures: totalFailures,
        success_rate_percent: Math.round(successRate * 100) / 100,
        duration_ms: {
          avg: Math.round(computationMetrics.avg * 100) / 100,
          p95: computationMetrics.p95,
          p99: computationMetrics.p99,
        },
      },
      deleted_contacts_cache: {
        hit_ratio_percent: Math.round(cacheHitRatio * 100) / 100,
        total_hits: totalCacheHits,
        total_misses: totalCacheMisses,
      },
      batch_processing: {
        avg_batch_size: Math.round(batchMetrics.avg * 100) / 100,
        total_batches: batchMetrics.count,
      },
    };
  }

  // Atomic Processing Metrics
  recordAtomicProcessing(params: {
    duration: number;
    segmentCount: number;
    successCount: number;
    errorCount: number;
    contactId: string;
    eventName: string;
  }): void {
    const {
      duration,
      segmentCount,
      successCount,
      errorCount,
      contactId,
      eventName,
    } = params;

    // Record duration
    this.segmentComputationDuration.observe(
      {
        operation: 'atomic',
        eventName,
        status: errorCount > 0 ? 'failure' : 'success',
      },
      duration,
    );

    // Record total attempts
    this.segmentComputationTotal.inc({
      operation: 'atomic',
      eventName,
      contactId,
    });

    // Record failures if any
    if (errorCount > 0) {
      this.segmentComputationFailures.inc({
        operation: 'atomic',
        eventName,
        errorType: 'processing_error',
      });
    }

    // Record batch size (number of segments processed)
    this.segmentBatchSize.observe({ operation: 'atomic' }, segmentCount);
  }

  // Single Contact Update Metrics
  recordSingleContactUpdate(params: {
    queryTime: number;
    cacheHit: boolean;
    success: boolean;
    segmentId: string;
    error?: string;
  }): void {
    const { queryTime, cacheHit, success, segmentId, error } = params;

    // Record query duration
    this.segmentComputationDuration.observe(
      {
        segmentId,
        operation: 'single_contact_update',
        status: success ? 'success' : 'failure',
        cache_hit: cacheHit ? 'true' : 'false',
      },
      queryTime,
    );

    // Record attempt
    this.segmentComputationTotal.inc({
      operation: 'single_contact_update',
    });

    // Record cache metrics
    if (cacheHit) {
      this.recordCacheHit();
    } else {
      this.recordCacheMiss();
    }

    // Record failure if needed
    if (!success && error) {
      this.segmentComputationFailures.inc({
        operation: 'single_contact_update',
        errorType: this.categorizeError(error),
      });
    }
  }

  private categorizeError(error: string): string {
    if (error.includes('timeout')) return 'timeout';
    if (error.includes('memory')) return 'memory_limit';
    if (error.includes('connection')) return 'connection_error';
    if (error.includes('query')) return 'query_error';
    return 'unknown_error';
  }

  // Get atomic processing metrics
  getAtomicProcessingMetrics() {
    const atomicMetrics = this.segmentComputationDuration.getMetrics({
      operation: 'atomic',
    });

    const totalAtomicRequests = this.segmentComputationTotal.getValue({
      operation: 'atomic',
    });

    const totalAtomicFailures = this.segmentComputationFailures.getValue({
      operation: 'atomic',
    });

    const atomicBatchMetrics = this.segmentBatchSize.getMetrics({
      operation: 'atomic',
    });

    const successRate =
      totalAtomicRequests > 0
        ? ((totalAtomicRequests - totalAtomicFailures) / totalAtomicRequests) *
          100
        : 100;

    return {
      atomic_processing: {
        total_requests: totalAtomicRequests,
        total_failures: totalAtomicFailures,
        success_rate_percent: Math.round(successRate * 100) / 100,
        duration_ms: {
          avg: Math.round(atomicMetrics.avg * 100) / 100,
          p95: atomicMetrics.p95,
          p99: atomicMetrics.p99,
        },
        segments_per_request: {
          avg: Math.round(atomicBatchMetrics.avg * 100) / 100,
          count: atomicBatchMetrics.count,
        },
      },
    };
  }

  // Get single contact update metrics
  getSingleContactUpdateMetrics() {
    const labels = { operation: 'single_contact_update' };

    const updateMetrics = this.segmentComputationDuration.getMetrics(labels);

    const totalUpdates = this.segmentComputationTotal.getValue(labels);
    const totalFailures = this.segmentComputationFailures.getValue(labels);

    const successRate =
      totalUpdates > 0
        ? ((totalUpdates - totalFailures) / totalUpdates) * 100
        : 100;

    return {
      single_contact_updates: {
        total_requests: totalUpdates,
        total_failures: totalFailures,
        success_rate_percent: Math.round(successRate * 100) / 100,
        duration_ms: {
          avg: Math.round(updateMetrics.avg * 100) / 100,
          p95: updateMetrics.p95,
          p99: updateMetrics.p99,
        },
      },
    };
  }

  // BATCH SEGMENT PROCESSING METRICS

  recordBatchProcessing(params: {
    duration: number;
    segmentId: string;
    eventCount: number;
    contactsCount: number;
    batchSize: number;
  }): void {
    const { duration, segmentId, eventCount, contactsCount, batchSize } =
      params;

    // Record batch processing duration
    this.segmentComputationDuration.observe(
      {
        operation: 'batch_segment',
        segmentId,
        status: 'success', // Failures would be caught and not reach this point
      },
      duration,
    );

    // Record total batch attempts
    this.segmentComputationTotal.inc({
      operation: 'batch_segment',
      segmentId,
    });

    // Record various batch metrics
    this.segmentBatchSize.observe({ operation: 'batch_segment' }, eventCount);
    this.segmentBatchSize.observe(
      { operation: 'batch_contacts' },
      contactsCount,
    );
    this.segmentBatchSize.observe({ operation: 'batch_chunk_size' }, batchSize);
  }

  recordBatchFailure(params: {
    segmentId: string;
    eventCount: number;
    errorType: string;
  }): void {
    const { segmentId, eventCount, errorType } = params;

    this.segmentComputationFailures.inc({
      operation: 'batch_segment',
      segmentId,
      errorType,
    });

    // Also record the attempt
    this.segmentComputationTotal.inc({
      operation: 'batch_segment',
      segmentId,
    });
  }

  // Get batch processing metrics
  getBatchProcessingMetrics() {
    const batchMetrics = this.segmentComputationDuration.getMetrics({
      operation: 'batch_segment',
    });

    const totalBatchRequests = this.segmentComputationTotal.getValue({
      operation: 'batch_segment',
    });

    const totalBatchFailures = this.segmentComputationFailures.getValue({
      operation: 'batch_segment',
    });

    const batchEventMetrics = this.segmentBatchSize.getMetrics({
      operation: 'batch_segment',
    });

    const batchContactMetrics = this.segmentBatchSize.getMetrics({
      operation: 'batch_contacts',
    });

    const batchChunkMetrics = this.segmentBatchSize.getMetrics({
      operation: 'batch_chunk_size',
    });

    const successRate =
      totalBatchRequests > 0
        ? ((totalBatchRequests - totalBatchFailures) / totalBatchRequests) * 100
        : 100;

    return {
      batch_processing: {
        total_requests: totalBatchRequests,
        total_failures: totalBatchFailures,
        success_rate_percent: Math.round(successRate * 100) / 100,
        duration_ms: {
          avg: Math.round(batchMetrics.avg * 100) / 100,
          p95: batchMetrics.p95,
          p99: batchMetrics.p99,
        },
        events_per_batch: {
          avg: Math.round(batchEventMetrics.avg * 100) / 100,
          count: batchEventMetrics.count,
        },
        contacts_per_batch: {
          avg: Math.round(batchContactMetrics.avg * 100) / 100,
          count: batchContactMetrics.count,
        },
        chunk_size: {
          avg: Math.round(batchChunkMetrics.avg * 100) / 100,
        },
      },
    };
  }

  // Buffer Management Metrics
  recordBufferMetrics(params: {
    bufferCount: number;
    memoryUsageMB: number;
    scheduledJobs: number;
    processingJobs: number;
  }): void {
    const { bufferCount, memoryUsageMB, scheduledJobs, processingJobs } =
      params;

    // Use batch size histogram to track buffer metrics
    this.segmentBatchSize.observe({ operation: 'buffer_count' }, bufferCount);
    this.segmentBatchSize.observe(
      { operation: 'buffer_memory' },
      memoryUsageMB,
    );
    this.segmentBatchSize.observe(
      { operation: 'scheduled_jobs' },
      scheduledJobs,
    );
    this.segmentBatchSize.observe(
      { operation: 'processing_jobs' },
      processingJobs,
    );
  }

  // Get buffer metrics
  getBufferMetrics() {
    const bufferCountMetrics = this.segmentBatchSize.getMetrics({
      operation: 'buffer_count',
    });

    const memoryMetrics = this.segmentBatchSize.getMetrics({
      operation: 'buffer_memory',
    });

    const scheduledJobsMetrics = this.segmentBatchSize.getMetrics({
      operation: 'scheduled_jobs',
    });

    const processingJobsMetrics = this.segmentBatchSize.getMetrics({
      operation: 'processing_jobs',
    });

    return {
      buffer_management: {
        buffer_count: {
          avg: Math.round(bufferCountMetrics.avg * 100) / 100,
          current: bufferCountMetrics.count > 0 ? bufferCountMetrics.p99 : 0,
        },
        memory_usage_mb: {
          avg: Math.round(memoryMetrics.avg * 100) / 100,
          current: memoryMetrics.count > 0 ? memoryMetrics.p99 : 0,
        },
        scheduled_jobs: {
          avg: Math.round(scheduledJobsMetrics.avg * 100) / 100,
          current:
            scheduledJobsMetrics.count > 0 ? scheduledJobsMetrics.p99 : 0,
        },
        processing_jobs: {
          avg: Math.round(processingJobsMetrics.avg * 100) / 100,
          current:
            processingJobsMetrics.count > 0 ? processingJobsMetrics.p99 : 0,
        },
      },
    };
  }

  // Enhanced metrics summary including batch processing
  getEnhancedMetricsSummary() {
    const baseMetrics = this.getMetricsSummary();
    const atomicMetrics = this.getAtomicProcessingMetrics();
    const batchMetrics = this.getBatchProcessingMetrics();
    const bufferMetrics = this.getBufferMetrics();

    return {
      ...baseMetrics,
      ...atomicMetrics,
      ...batchMetrics,
      ...bufferMetrics,
      summary: {
        total_processing_requests:
          baseMetrics.segment_computation.total_requests +
          (atomicMetrics.atomic_processing?.total_requests || 0) +
          (batchMetrics.batch_processing?.total_requests || 0),

        overall_success_rate: this.calculateOverallSuccessRate(
          baseMetrics,
          atomicMetrics,
          batchMetrics,
        ),

        processing_modes: {
          atomic_enabled:
            (atomicMetrics.atomic_processing?.total_requests || 0) > 0,
          batch_enabled:
            (batchMetrics.batch_processing?.total_requests || 0) > 0,
          legacy_enabled: baseMetrics.segment_computation.total_requests > 0,
        },
      },
    };
  }

  private calculateOverallSuccessRate(
    baseMetrics: any,
    atomicMetrics: any,
    batchMetrics: any,
  ): number {
    const totalRequests =
      baseMetrics.segment_computation.total_requests +
      (atomicMetrics.atomic_processing?.total_requests || 0) +
      (batchMetrics.batch_processing?.total_requests || 0);

    const totalFailures =
      baseMetrics.segment_computation.total_failures +
      (atomicMetrics.atomic_processing?.total_failures || 0) +
      (batchMetrics.batch_processing?.total_failures || 0);

    if (totalRequests === 0) return 100;

    return (
      Math.round(((totalRequests - totalFailures) / totalRequests) * 10000) /
      100
    );
  }

  // Reset metrics (useful for testing)
  resetMetrics(): void {
    // Create new instances to clear all data
    Object.assign(this, {
      segmentComputationDuration: new InMemoryHistogram(),
      segmentComputationTotal: new InMemoryCounter(),
      segmentComputationFailures: new InMemoryCounter(),
      deletedContactsCacheHits: new InMemoryCounter(),
      deletedContactsCacheMisses: new InMemoryCounter(),
      segmentBatchSize: new InMemoryHistogram(),
    });

    this.logger.log('All metrics have been reset');
  }
}
