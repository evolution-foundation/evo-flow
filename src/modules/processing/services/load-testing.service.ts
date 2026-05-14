import { Injectable } from '@nestjs/common';
import { ProcessingService } from '../processing.service';
import { EventData } from '../interfaces/event-data.interface';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface LoadTestConfig {
  totalEvents: number;
  eventsPerSecond: number;
  durationMinutes: number;
  concurrentUsers: number;
  eventTypes: string[];
}

interface LoadTestResult {
  totalEventsSent: number;
  totalEventsProcessed: number;
  averageLatency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  throughputActual: number;
  durationMs: number;
  errors: string[];
  partitionDistribution: Record<string, number>;
}

interface LoadTestMetrics {
  eventsSent: number;
  eventsProcessed: number;
  errors: number;
  latencies: number[];
  startTime: number;
  lastEventTime: number;
  errorMessages: string[];
}

@Injectable()
export class LoadTestingService {
  private readonly logger = new CustomLoggerService(LoadTestingService.name);
  private isRunning = false;

  constructor(private processingService: ProcessingService) {
    this.logger.log('🚀 Load Testing Service initialized');
  }

  /**
   * 🎯 HIGH VOLUME LOAD TEST
   * Validates system capacity for 10M+ events per day
   */
  async executeLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
    if (this.isRunning) {
      throw new Error('Load test already running');
    }

    this.isRunning = true;
    const metrics: LoadTestMetrics = {
      eventsSent: 0,
      eventsProcessed: 0,
      errors: 0,
      latencies: [],
      startTime: Date.now(),
      lastEventTime: 0,
      errorMessages: [],
    };

    try {
      this.logger.log(
        `🏁 Starting load test: ${config.totalEvents} events @ ${config.eventsPerSecond}/s`,
      );

      // Calculate test parameters
      const intervalMs = 1000 / config.eventsPerSecond;
      const eventsPerBatch = Math.max(
        1,
        Math.floor(config.eventsPerSecond / 10),
      ); // 10 batches per second
      const batchIntervalMs = 100; // 10 batches per second

      // Generate test data
      const testEvents = this.generateTestEvents(config);

      // Execute load test with controlled rate
      await this.executeControlledLoadTest(
        testEvents,
        eventsPerBatch,
        batchIntervalMs,
        metrics,
      );

      // Calculate results
      const result = this.calculateResults(metrics, config);

      this.logger.log(
        `🏆 Load test completed: ${result.totalEventsSent} events, ${result.throughputActual.toFixed(0)} events/s`,
      );

      return result;
    } catch (error) {
      this.logger.error(`Load test failed: ${error.message}`, error.stack);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 🚀 SPRINT 2 VALIDATION TEST
   * Specific test to validate Sprint 2 batch processing goals
   */
  async validateSprint2Performance(): Promise<LoadTestResult> {
    const config: LoadTestConfig = {
      totalEvents: 100000,
      eventsPerSecond: 1000,
      durationMinutes: 5,
      concurrentUsers: 50,
      eventTypes: ['track', 'identify', 'page'],
    };

    this.logger.log('🎯 Running Sprint 2 batch processing validation test...');

    const result = await this.executeLoadTest(config);

    // Validate Sprint 2 targets
    const validationResults = this.validateSprint2Targets(result);
    this.logValidationResults(validationResults);

    return result;
  }

  /**
   * Generate realistic test events
   */
  private generateTestEvents(config: LoadTestConfig): EventData[] {
    const events: EventData[] = [];

    for (let i = 0; i < config.totalEvents; i++) {
      const eventType = config.eventTypes[i % config.eventTypes.length];

      const event: EventData = {
        messageId: `load-test-${i}-${Date.now()}`,
        eventType: eventType as any,
        eventName: this.generateEventName(eventType),
        contactId: `contact-${Math.floor(i / 10)}`, // 10 events per contact
        anonymousId: `anon-${i}`,
        timestamp: new Date().toISOString(),
        properties: {
          testEvent: true,
          loadTestId: `sprint2-validation-${Date.now()}`,
          eventIndex: i,
          batchId: Math.floor(i / 100), // 100 events per batch
        },
        traits: {
          source: 'load-test',
          priority: i % 3 === 0 ? 'HIGH' : i % 2 === 0 ? 'NORMAL' : 'LOW',
        },
      };

      events.push(event);
    }

    return events;
  }

  /**
   * Execute load test with controlled rate limiting
   */
  private async executeControlledLoadTest(
    events: EventData[],
    eventsPerBatch: number,
    batchIntervalMs: number,
    metrics: LoadTestMetrics,
  ): Promise<void> {
    // Process events in batches to control rate
    for (let i = 0; i < events.length; i += eventsPerBatch) {
      const batch = events.slice(i, i + eventsPerBatch);

      // Process batch in parallel
      const batchPromises = batch.map(async (event) => {
        const startTime = Date.now();

        try {
          await this.processingService.processEvent(event);

          const latency = Date.now() - startTime;
          metrics.latencies.push(latency);
          metrics.eventsProcessed++;
          metrics.lastEventTime = Date.now();
        } catch (error) {
          metrics.errors++;
          metrics.errorMessages.push(
            `Event ${event.messageId}: ${error.message}`,
          );
          this.logger.error(
            `Event processing failed: ${event.messageId} - ${error.message}`,
          );
        }

        metrics.eventsSent++;
      });

      await Promise.allSettled(batchPromises);

      // Rate limiting delay
      if (i + eventsPerBatch < events.length) {
        await this.sleep(batchIntervalMs);
      }

      // Log progress every 1000 events
      if (metrics.eventsSent % 1000 === 0) {
        const throughput =
          metrics.eventsSent / ((Date.now() - metrics.startTime) / 1000);
        this.logger.log(
          `📊 Progress: ${metrics.eventsSent}/${events.length} events (${throughput.toFixed(0)} events/s)`,
        );
      }
    }
  }

  /**
   * Calculate load test results
   */
  private calculateResults(
    metrics: LoadTestMetrics,
    config: LoadTestConfig,
  ): LoadTestResult {
    const durationMs = metrics.lastEventTime - metrics.startTime;
    const durationSeconds = durationMs / 1000;

    // Sort latencies for percentile calculations
    const sortedLatencies = metrics.latencies.sort((a, b) => a - b);

    const result: LoadTestResult = {
      totalEventsSent: metrics.eventsSent,
      totalEventsProcessed: metrics.eventsProcessed,
      averageLatency:
        metrics.latencies.reduce((sum, lat) => sum + lat, 0) /
          metrics.latencies.length || 0,
      p95Latency: this.calculatePercentile(sortedLatencies, 95),
      p99Latency: this.calculatePercentile(sortedLatencies, 99),
      errorRate:
        metrics.eventsSent > 0
          ? (metrics.errors / metrics.eventsSent) * 100
          : 0,
      throughputActual: metrics.eventsSent / durationSeconds,
      durationMs,
      errors: metrics.errorMessages.slice(0, 10), // First 10 errors
      partitionDistribution: {}, // Would be populated from Kafka metrics
    };

    return result;
  }

  /**
   * Validate Sprint 2 performance targets
   */
  private validateSprint2Targets(result: LoadTestResult) {
    const targets = {
      throughput: 1000, // 1K events/s minimum
      errorRate: 1, // < 1% error rate
      p95Latency: 30000, // < 30s P95 latency for batch processing
      p99Latency: 60000, // < 60s P99 latency
    };

    return {
      throughputPassed: result.throughputActual >= targets.throughput,
      errorRatePassed: result.errorRate <= targets.errorRate,
      p95LatencyPassed: result.p95Latency <= targets.p95Latency,
      p99LatencyPassed: result.p99Latency <= targets.p99Latency,
      overallPassed:
        result.throughputActual >= targets.throughput &&
        result.errorRate <= targets.errorRate &&
        result.p95Latency <= targets.p95Latency &&
        result.p99Latency <= targets.p99Latency,
      targets,
      actual: {
        throughput: result.throughputActual,
        errorRate: result.errorRate,
        p95Latency: result.p95Latency,
        p99Latency: result.p99Latency,
      },
    };
  }

  /**
   * Log validation results
   */
  private logValidationResults(validation: any): void {
    this.logger.log('🎯 Sprint 2 Validation Results:');
    this.logger.log(
      `   Throughput: ${validation.actual.throughput.toFixed(0)} events/s (target: ${validation.targets.throughput}) - ${validation.throughputPassed ? '✅ PASS' : '❌ FAIL'}`,
    );
    this.logger.log(
      `   Error Rate: ${validation.actual.errorRate.toFixed(2)}% (target: <${validation.targets.errorRate}%) - ${validation.errorRatePassed ? '✅ PASS' : '❌ FAIL'}`,
    );
    this.logger.log(
      `   P95 Latency: ${validation.actual.p95Latency.toFixed(0)}ms (target: <${validation.targets.p95Latency}ms) - ${validation.p95LatencyPassed ? '✅ PASS' : '❌ FAIL'}`,
    );
    this.logger.log(
      `   P99 Latency: ${validation.actual.p99Latency.toFixed(0)}ms (target: <${validation.targets.p99Latency}ms) - ${validation.p99LatencyPassed ? '✅ PASS' : '❌ FAIL'}`,
    );
    this.logger.log(
      `   Overall: ${validation.overallPassed ? '🏆 SPRINT 2 TARGETS ACHIEVED' : '🔥 NEEDS OPTIMIZATION'}`,
    );
  }

  /**
   * Utility methods
   */
  private generateEventName(eventType: string): string {
    const eventNames = {
      track: [
        'page_viewed',
        'button_clicked',
        'form_submitted',
        'video_played',
        'purchase_completed',
      ],
      identify: [
        'user_registered',
        'profile_updated',
        'email_verified',
        'subscription_started',
      ],
      page: ['homepage', 'product_page', 'checkout_page', 'thank_you_page'],
    };

    const names = eventNames[eventType] || ['generic_event'];
    return names[Math.floor(Math.random() * names.length)];
  }

  private calculatePercentile(
    sortedArray: number[],
    percentile: number,
  ): number {
    if (sortedArray.length === 0) return 0;

    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.min(index, sortedArray.length - 1)];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current load testing status
   */
  getLoadTestStatus() {
    return {
      isRunning: this.isRunning,
      capabilities: {
        maxEventsPerTest: 1000000, // 1M events per test
        maxConcurrentUsers: 1000,
        supportedEventTypes: ['track', 'identify', 'page', 'screen'],
        validationTargets: {
          throughput: '1K+ events/s',
          errorRate: '< 1%',
          p95Latency: '< 30s',
          p99Latency: '< 60s',
        },
      },
      recommendedTests: [
        'Sprint 2 Validation (100K events)',
        'Daily Load Simulation (10M events)',
        'Peak Traffic Test (50K events/s)',
        'Account Isolation Test (Multi-tenant)',
      ],
    };
  }
}
