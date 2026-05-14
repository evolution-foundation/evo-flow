import { Injectable } from '@nestjs/common';
import { EventData } from '../interfaces/event-data.interface';
import { KafkaService } from '../kafka/kafka.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface DLQEvent {
  originalEvent: EventData;
  failureReason: string;
  failureCount: number;
  firstFailureAt: string;
  lastFailureAt: string;
  stackTrace?: string;
  processingMetadata?: {
    segmentId?: string;
    batchId?: string;
    attemptedAt?: string;
    processingType: 'ATOMIC' | 'BATCH' | 'CRON';
  };
}

interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

@Injectable()
export class DeadLetterQueueService {
  private readonly logger = new CustomLoggerService(
    DeadLetterQueueService.name,
  );

  // DLQ Storage (in production, this should be Redis or database)
  private readonly failedEvents = new Map<string, DLQEvent>();
  private readonly retryQueue = new Map<string, NodeJS.Timeout>();

  // Retry policies by processing type
  private readonly retryPolicies: Record<string, RetryPolicy> = {
    ATOMIC: {
      maxRetries: 3,
      backoffMultiplier: 2,
      baseDelayMs: 1000, // Start with 1s
      maxDelayMs: 30000, // Max 30s
    },
    BATCH: {
      maxRetries: 5,
      backoffMultiplier: 2,
      baseDelayMs: 5000, // Start with 5s
      maxDelayMs: 300000, // Max 5min
    },
    CRON: {
      maxRetries: 10,
      backoffMultiplier: 1.5,
      baseDelayMs: 60000, // Start with 1min
      maxDelayMs: 3600000, // Max 1hour
    },
  };

  constructor(private kafkaService: KafkaService) {
    this.logger.log('🚀 Dead Letter Queue service initialized');

    // Periodic cleanup of old failed events (every 30 minutes)
    setInterval(() => this.cleanupOldEvents(), 30 * 60 * 1000);
  }

  /**
   * 🚨 DEAD LETTER QUEUE: Handle failed event processing
   * This method is called when event processing fails after all circuit breaker attempts
   */
  async handleFailedEvent(
    event: EventData,
    error: Error,
    processingMetadata?: {
      segmentId?: string;
      batchId?: string;
      attemptedAt?: string;
      processingType: 'ATOMIC' | 'BATCH' | 'CRON';
    },
  ): Promise<void> {
    const eventId = this.generateEventId(event);
    const now = new Date().toISOString();

    try {
      // Get or create DLQ event
      let dlqEvent = this.failedEvents.get(eventId);

      if (dlqEvent) {
        // Update existing failed event
        dlqEvent.failureCount++;
        dlqEvent.lastFailureAt = now;
        dlqEvent.failureReason = error.message;
        dlqEvent.stackTrace = error.stack;
        if (processingMetadata) {
          dlqEvent.processingMetadata = processingMetadata;
        }
      } else {
        // Create new DLQ event
        dlqEvent = {
          originalEvent: event,
          failureReason: error.message,
          failureCount: 1,
          firstFailureAt: now,
          lastFailureAt: now,
          stackTrace: error.stack,
          processingMetadata: processingMetadata
            ? processingMetadata
            : undefined,
        };
        this.failedEvents.set(eventId, dlqEvent);
      }

      if (!dlqEvent) {
        throw new Error(`Failed to create or update DLQ event: ${eventId}`);
      }

      this.logger.error(
        `📨 Event sent to DLQ: ${eventId} (attempt ${dlqEvent.failureCount}) - ${error.message}`,
      );

      // Decide whether to retry or give up
      await this.evaluateRetryOrDiscard(eventId, dlqEvent);
    } catch (dlqError) {
      this.logger.error(
        `Failed to handle DLQ event ${eventId}: ${dlqError.message}`,
        dlqError.stack,
      );
    }
  }

  /**
   * Evaluate whether to retry failed event or permanently discard
   */
  private async evaluateRetryOrDiscard(
    eventId: string,
    dlqEvent: DLQEvent,
  ): Promise<void> {
    const processingType =
      dlqEvent.processingMetadata?.processingType || 'ATOMIC';
    const retryPolicy = this.retryPolicies[processingType];

    if (dlqEvent.failureCount >= retryPolicy.maxRetries) {
      // Max retries exceeded - send to permanent DLQ
      await this.sendToPermanentDLQ(eventId, dlqEvent);
      this.failedEvents.delete(eventId);

      this.logger.error(
        `💀 Event permanently failed after ${dlqEvent.failureCount} attempts: ${eventId}`,
      );
    } else {
      // Schedule retry with exponential backoff
      await this.scheduleRetry(eventId, dlqEvent, retryPolicy);
    }
  }

  /**
   * Schedule retry with exponential backoff
   */
  private async scheduleRetry(
    eventId: string,
    dlqEvent: DLQEvent,
    retryPolicy: RetryPolicy,
  ): Promise<void> {
    // Calculate delay with exponential backoff
    const delay = Math.min(
      retryPolicy.baseDelayMs *
        Math.pow(retryPolicy.backoffMultiplier, dlqEvent.failureCount - 1),
      retryPolicy.maxDelayMs,
    );

    // Cancel existing retry if any
    const existingRetry = this.retryQueue.get(eventId);
    if (existingRetry) {
      clearTimeout(existingRetry);
    }

    // Schedule new retry
    const retryTimer = setTimeout(async () => {
      try {
        await this.retryFailedEvent(eventId, dlqEvent);
      } catch (error) {
        this.logger.error(`Failed to retry event ${eventId}: ${error.message}`);
      } finally {
        this.retryQueue.delete(eventId);
      }
    }, delay);

    this.retryQueue.set(eventId, retryTimer);

    this.logger.warn(
      `🔄 Scheduled retry for ${eventId} in ${Math.round(delay / 1000)}s (attempt ${dlqEvent.failureCount + 1}/${retryPolicy.maxRetries})`,
    );
  }

  /**
   * Retry failed event by sending it back to Kafka
   */
  private async retryFailedEvent(
    eventId: string,
    dlqEvent: DLQEvent,
  ): Promise<void> {
    this.logger.log(`🔄 Retrying failed event: ${eventId}`);

    try {
      // Add retry metadata to event
      const retryEvent = {
        ...dlqEvent.originalEvent,
        properties: {
          ...dlqEvent.originalEvent.properties,
          _retry: true,
          _retryAttempt: dlqEvent.failureCount + 1,
          _firstFailedAt: dlqEvent.firstFailureAt,
          _lastFailedAt: dlqEvent.lastFailureAt,
        },
      };

      // Send back to Kafka for reprocessing
      await this.kafkaService.sendEvent(retryEvent);

      // Remove from failed events map (will be re-added if it fails again)
      this.failedEvents.delete(eventId);

      this.logger.log(`✅ Event retry sent: ${eventId}`);
    } catch (error) {
      // Retry failed - this will trigger another DLQ handling
      throw new Error(`Retry failed for ${eventId}: ${error.message}`);
    }
  }

  /**
   * Send event to permanent DLQ (external storage or alerting)
   */
  private async sendToPermanentDLQ(
    eventId: string,
    dlqEvent: DLQEvent,
  ): Promise<void> {
    try {
      // In production, this would send to:
      // - External DLQ topic in Kafka
      // - Database for manual investigation
      // - Monitoring/alerting system

      this.logger.error(
        `💀 PERMANENT DLQ: Event ${eventId} failed permanently after ${dlqEvent.failureCount} attempts`,
        {
          eventId,
          failureCount: dlqEvent.failureCount,
          failureReason: dlqEvent.failureReason,
          firstFailureAt: dlqEvent.firstFailureAt,
          lastFailureAt: dlqEvent.lastFailureAt,
          processingType: dlqEvent.processingMetadata?.processingType,
          segmentId: dlqEvent.processingMetadata?.segmentId,
        },
      );

      // TODO: Implement external DLQ storage
      // await this.externalStorage.save(dlqEvent);
      // await this.alertingService.sendAlert(dlqEvent);
    } catch (error) {
      this.logger.error(
        `Failed to send to permanent DLQ: ${eventId} - ${error.message}`,
      );
    }
  }

  /**
   * Generate consistent event ID for DLQ tracking
   */
  private generateEventId(event: EventData): string {
    return (
      event.messageId ||
      `${event.contactId}:${event.eventType}:${event.timestamp}`
    );
  }

  /**
   * Clean up old events from memory (older than 24 hours)
   */
  private cleanupOldEvents(): void {
    const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    let cleanedCount = 0;

    for (const [eventId, dlqEvent] of this.failedEvents.entries()) {
      const eventTime = new Date(dlqEvent.firstFailureAt).getTime();
      if (eventTime < cutoffTime) {
        this.failedEvents.delete(eventId);

        // Cancel any pending retries
        const retryTimer = this.retryQueue.get(eventId);
        if (retryTimer) {
          clearTimeout(retryTimer);
          this.retryQueue.delete(eventId);
        }

        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`🧹 Cleaned up ${cleanedCount} old DLQ events`);
    }
  }

  /**
   * Get DLQ statistics for monitoring
   */
  getDLQStats() {
    const eventsByType = new Map<string, number>();
    let totalRetries = 0;

    for (const dlqEvent of this.failedEvents.values()) {
      const processingType =
        dlqEvent.processingMetadata?.processingType || 'UNKNOWN';

      eventsByType.set(
        processingType,
        (eventsByType.get(processingType) || 0) + 1,
      );
      totalRetries += dlqEvent.failureCount;
    }

    return {
      totalFailedEvents: this.failedEvents.size,
      activeRetries: this.retryQueue.size,
      totalRetryAttempts: totalRetries,
      averageRetries:
        this.failedEvents.size > 0 ? totalRetries / this.failedEvents.size : 0,
      eventsByProcessingType: Object.fromEntries(eventsByType),
      retryPolicies: this.retryPolicies,
    };
  }

  /**
   * Manual retry of specific event (for admin intervention)
   */
  async manualRetry(eventId: string): Promise<boolean> {
    const dlqEvent = this.failedEvents.get(eventId);
    if (!dlqEvent) {
      this.logger.warn(`Event not found in DLQ: ${eventId}`);
      return false;
    }

    try {
      await this.retryFailedEvent(eventId, dlqEvent);
      this.logger.log(`🔧 Manual retry successful: ${eventId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `🔧 Manual retry failed: ${eventId} - ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get all failed events for admin interface
   */
  getFailedEvents(): Array<{ id: string; event: DLQEvent }> {
    return Array.from(this.failedEvents.entries()).map(([id, event]) => ({
      id,
      event,
    }));
  }
}
