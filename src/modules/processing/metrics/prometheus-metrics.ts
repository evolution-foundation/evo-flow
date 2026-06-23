import { Injectable } from '@nestjs/common';
import {
  register,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class PrometheusMetrics {
  private readonly logger = new CustomLoggerService(PrometheusMetrics.name);

  // Event processing metrics
  public readonly eventsTotal = new Counter({
    name: 'evo_campaign_events_total',
    help: 'Total number of events processed',
    labelNames: ['event_type', 'status', 'queue_mode', 'storage_mode'],
  });

  public readonly eventProcessingDuration = new Histogram({
    name: 'evo_campaign_event_processing_duration_seconds',
    help: 'Time spent processing events',
    labelNames: ['event_type', 'queue_mode', 'storage_mode'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  });

  public readonly eventBatchSize = new Histogram({
    name: 'evo_campaign_event_batch_size',
    help: 'Size of event batches processed',
    labelNames: ['processor_type', 'storage_mode'],
    buckets: [1, 10, 50, 100, 500, 1000, 5000],
  });

  // Queue metrics
  public readonly queueLength = new Gauge({
    name: 'evo_campaign_queue_length',
    help: 'Current length of processing queues',
    labelNames: ['queue_type', 'queue_name'],
  });

  public readonly queueProcessingRate = new Gauge({
    name: 'evo_campaign_queue_processing_rate',
    help: 'Rate of queue processing (events per second)',
    labelNames: ['queue_type'],
  });

  public readonly queueBackpressure = new Gauge({
    name: 'evo_campaign_queue_backpressure_ratio',
    help: 'Queue utilization ratio (0-1)',
    labelNames: ['queue_type'],
  });

  // EVO-1764: Temporal task-queue executor health. `poller_type` is
  // 'workflow' | 'activity'; a journey needs a WORKFLOW poller to run, so the
  // WORKFLOW series is the authoritative "is there an executor" signal.
  public readonly temporalTaskQueuePollers = new Gauge({
    name: 'evo_temporal_task_queue_pollers',
    help: 'Number of pollers registered on a Temporal task queue, by poller type',
    labelNames: ['task_queue', 'poller_type'],
  });

  // Seconds the queue has had zero WORKFLOW pollers (0 when healthy). Climbs
  // while no executor is present; an infra alert/Grafana rule thresholds this.
  public readonly temporalTaskQueueZeroPollerSeconds = new Gauge({
    name: 'evo_temporal_task_queue_zero_poller_seconds',
    help: 'Seconds a Temporal task queue has had zero WORKFLOW pollers (0 when healthy)',
    labelNames: ['task_queue'],
  });

  /** EVO-1764: publish the journey-execution queue-health gauges in one shot. */
  setTemporalTaskQueueMetrics(
    taskQueue: string,
    workflowPollers: number,
    activityPollers: number,
    zeroPollerSeconds: number,
  ): void {
    this.temporalTaskQueuePollers.set(
      { task_queue: taskQueue, poller_type: 'workflow' },
      workflowPollers,
    );
    this.temporalTaskQueuePollers.set(
      { task_queue: taskQueue, poller_type: 'activity' },
      activityPollers,
    );
    this.temporalTaskQueueZeroPollerSeconds.set(
      { task_queue: taskQueue },
      zeroPollerSeconds,
    );
  }

  // Storage metrics
  public readonly storageOperationsTotal = new Counter({
    name: 'evo_campaign_storage_operations_total',
    help: 'Total storage operations',
    labelNames: ['storage_type', 'operation', 'status'],
  });

  public readonly storageOperationDuration = new Histogram({
    name: 'evo_campaign_storage_operation_duration_seconds',
    help: 'Duration of storage operations',
    labelNames: ['storage_type', 'operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  });

  public readonly connectionPoolStats = new Gauge({
    name: 'evo_campaign_connection_pool_connections',
    help: 'Connection pool statistics',
    labelNames: ['pool_type', 'state'], // state: available, borrowed, pending, invalid
  });

  // Circuit breaker metrics
  public readonly circuitBreakerState = new Gauge({
    name: 'evo_campaign_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['breaker_name'],
  });

  public readonly circuitBreakerFailures = new Counter({
    name: 'evo_campaign_circuit_breaker_failures_total',
    help: 'Total circuit breaker failures',
    labelNames: ['breaker_name'],
  });

  public readonly circuitBreakerSuccesses = new Counter({
    name: 'evo_campaign_circuit_breaker_successes_total',
    help: 'Total circuit breaker successes',
    labelNames: ['breaker_name'],
  });

  // System metrics
  public readonly httpRequestsTotal = new Counter({
    name: 'evo_campaign_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
  });

  public readonly httpRequestDuration = new Histogram({
    name: 'evo_campaign_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  });

  public readonly activeConnections = new Gauge({
    name: 'evo_campaign_active_connections',
    help: 'Number of active connections',
    labelNames: ['connection_type'], // websocket, http, database
  });

  public readonly uniqueUsers = new Gauge({
    name: 'evo_campaign_unique_users',
    help: 'Number of unique users in time window',
    labelNames: ['time_window'], // 1h, 24h, 7d
  });

  public readonly dataVolume = new Counter({
    name: 'evo_campaign_data_volume_bytes_total',
    help: 'Total volume of data processed',
    labelNames: ['data_type'], // events, properties, traits
  });

  constructor() {
    this.logger.log('Initializing Prometheus metrics...');

    // Collect default Node.js metrics
    collectDefaultMetrics({
      prefix: 'evo_campaign_',
      register,
    });

    this.logger.log('Prometheus metrics initialized');
  }

  // Helper methods for common operations
  recordEventProcessed(
    eventType: string,
    status: 'success' | 'error',
    queueMode: string,
    storageMode: string,
    durationSeconds?: number,
  ): void {
    this.eventsTotal.inc({
      event_type: eventType,
      status,
      queue_mode: queueMode,
      storage_mode: storageMode,
    });

    if (durationSeconds) {
      this.eventProcessingDuration.observe(
        {
          event_type: eventType,
          queue_mode: queueMode,
          storage_mode: storageMode,
        },
        durationSeconds,
      );
    }
  }

  recordBatchProcessed(
    processorType: string,
    storageMode: string,
    batchSize: number,
    durationSeconds: number,
  ): void {
    this.eventBatchSize.observe(
      { processor_type: processorType, storage_mode: storageMode },
      batchSize,
    );

    // Calculate processing rate
    if (durationSeconds > 0) {
      const rate = batchSize / durationSeconds;
      this.queueProcessingRate.set({ queue_type: processorType }, rate);
    }
  }

  recordStorageOperation(
    storageType: string,
    operation: string,
    status: 'success' | 'error',
    durationSeconds: number,
  ): void {
    this.storageOperationsTotal.inc({
      storage_type: storageType,
      operation,
      status,
    });
    this.storageOperationDuration.observe(
      { storage_type: storageType, operation },
      durationSeconds,
    );
  }

  updateQueueMetrics(
    queueType: string,
    queueName: string,
    length: number,
    utilizationRatio: number,
  ): void {
    this.queueLength.set(
      { queue_type: queueType, queue_name: queueName },
      length,
    );
    this.queueBackpressure.set({ queue_type: queueType }, utilizationRatio);
  }

  updateConnectionPoolMetrics(
    poolType: string,
    available: number,
    borrowed: number,
    pending: number,
    invalid: number,
  ): void {
    this.connectionPoolStats.set(
      { pool_type: poolType, state: 'available' },
      available,
    );
    this.connectionPoolStats.set(
      { pool_type: poolType, state: 'borrowed' },
      borrowed,
    );
    this.connectionPoolStats.set(
      { pool_type: poolType, state: 'pending' },
      pending,
    );
    this.connectionPoolStats.set(
      { pool_type: poolType, state: 'invalid' },
      invalid,
    );
  }

  updateCircuitBreakerMetrics(
    breakerName: string,
    state: 'closed' | 'half-open' | 'open',
    failures: number,
    successes: number,
  ): void {
    const stateValue = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
    this.circuitBreakerState.set({ breaker_name: breakerName }, stateValue);
    this.circuitBreakerFailures.inc({ breaker_name: breakerName }, failures);
    this.circuitBreakerSuccesses.inc({ breaker_name: breakerName }, successes);
  }

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    this.httpRequestsTotal.inc({
      method,
      route,
      status_code: statusCode.toString(),
    });
    this.httpRequestDuration.observe({ method, route }, durationSeconds);
  }

  recordDataVolume(dataType: string, bytes: number): void {
    this.dataVolume.inc({ data_type: dataType }, bytes);
  }

  updateActiveConnections(connectionType: string, count: number): void {
    this.activeConnections.set({ connection_type: connectionType }, count);
  }

  // Get metrics for /metrics endpoint
  async getMetrics(): Promise<string> {
    return await register.metrics();
  }

  // Reset all metrics (useful for testing)
  reset(): void {
    register.resetMetrics();
  }

  // Custom business metrics
  recordUniqueUsers(timeWindow: string, count: number): void {
    this.uniqueUsers.set({ time_window: timeWindow }, count);
  }

  // Health check metrics
  recordHealthCheck(service: string, status: 'healthy' | 'unhealthy'): void {
    const healthStatus = new Gauge({
      name: 'evo_campaign_health_status',
      help: 'Service health status (1=healthy, 0=unhealthy)',
      labelNames: ['service'],
    });

    healthStatus.set({ service }, status === 'healthy' ? 1 : 0);
  }
}
