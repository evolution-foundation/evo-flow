import { Injectable } from '@nestjs/common';
import { EventData } from '../interfaces/event-data.interface';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface DebouncedEvent {
  latestEvent: EventData;
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
  contactId: string;
  eventKey: string; // Combined key for deduplication
}

interface DebounceConfig {
  windowMs: number; // Time window for consolidation
  maxEvents: number; // Max events to consolidate
  highPriorityEvents: string[]; // Events that bypass debouncing
}

@Injectable()
export class IntelligentDebouncerService {
  private readonly logger = new CustomLoggerService(
    IntelligentDebouncerService.name,
  );

  // Active debouncing windows
  private readonly debouncedEvents = new Map<string, DebouncedEvent>();
  private readonly scheduledFlushes = new Map<string, NodeJS.Timeout>();

  // Configuration
  private readonly config: DebounceConfig = {
    windowMs: 5000, // 5 second consolidation window
    maxEvents: 50, // Max 50 similar events
    highPriorityEvents: [
      'user_registered',
      'purchase_completed',
      'subscription_started',
      'subscription_cancelled',
      'payment_failed',
    ],
  };

  /**
   * 🚀 INTELLIGENT DEBOUNCING
   * Consolidates similar events to reduce processing load
   *
   * Strategy:
   * - Same contact + same event type + same account = consolidate
   * - High priority events bypass debouncing
   * - Auto-flush after time window or max events
   */
  async debounceEvent(
    eventData: EventData,
    callback: (consolidatedEvent: EventData) => Promise<void>,
  ): Promise<void> {
    const eventKey = this.generateEventKey(eventData);

    // High priority events bypass debouncing
    if (this.isHighPriorityEvent(eventData)) {
      this.logger.debug(
        `🚀 High priority event bypassing debouncer: ${eventData.eventName}`,
      );
      await callback(eventData);
      return;
    }

    // Check if this event should be debounced
    const existingDebounce = this.debouncedEvents.get(eventKey);

    if (existingDebounce) {
      // Update existing debounced event
      this.updateDebouncedEvent(existingDebounce, eventData);

      // Force flush if we hit max events
      if (existingDebounce.count >= this.config.maxEvents) {
        this.logger.debug(
          `🔥 Force flushing debounced event (max events): ${eventKey}`,
        );
        await this.flushDebouncedEvent(eventKey, callback);
      }
    } else {
      // Create new debounced event
      this.createDebouncedEvent(eventKey, eventData);

      // Schedule flush
      this.scheduleFlush(eventKey, callback);
    }
  }

  /**
   * Generate unique key for event consolidation
   * Format:
   */
  private generateEventKey(eventData: EventData): string {
    const eventName = eventData.eventName || eventData.eventType || 'unknown';
    return `${eventData.contactId}:${eventData.eventType}:${eventName}`;
  }

  /**
   * Check if event should bypass debouncing (high priority)
   */
  private isHighPriorityEvent(eventData: EventData): boolean {
    if (!eventData.eventName) return false;

    return this.config.highPriorityEvents.some((priorityEvent) =>
      eventData.eventName?.toLowerCase().includes(priorityEvent.toLowerCase()),
    );
  }

  /**
   * Create new debounced event entry
   */
  private createDebouncedEvent(eventKey: string, eventData: EventData): void {
    const now = Date.now();

    this.debouncedEvents.set(eventKey, {
      latestEvent: eventData,
      count: 1,
      firstTimestamp: now,
      lastTimestamp: now,
      contactId: eventData.contactId || '',
      eventKey,
    });

    this.logger.debug(`🎯 Created debounced event: ${eventKey}`);
  }

  /**
   * Update existing debounced event with new data
   */
  private updateDebouncedEvent(
    debouncedEvent: DebouncedEvent,
    newEventData: EventData,
  ): void {
    // Merge properties (new properties override old ones)
    const mergedProperties = {
      ...debouncedEvent.latestEvent.properties,
      ...newEventData.properties,
    };

    // Update with latest event data
    debouncedEvent.latestEvent = {
      ...newEventData,
      properties: mergedProperties,
    };

    debouncedEvent.count++;
    debouncedEvent.lastTimestamp = Date.now();

    this.logger.debug(
      `📈 Updated debounced event: ${debouncedEvent.eventKey} (count: ${debouncedEvent.count})`,
    );
  }

  /**
   * Schedule automatic flush of debounced event
   */
  private scheduleFlush(
    eventKey: string,
    callback: (consolidatedEvent: EventData) => Promise<void>,
  ): void {
    // Clear existing timer if any
    const existingTimer = this.scheduledFlushes.get(eventKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new flush
    const timer = setTimeout(async () => {
      await this.flushDebouncedEvent(eventKey, callback);
    }, this.config.windowMs);

    this.scheduledFlushes.set(eventKey, timer);
  }

  /**
   * Flush debounced event and execute callback
   */
  private async flushDebouncedEvent(
    eventKey: string,
    callback: (consolidatedEvent: EventData) => Promise<void>,
  ): Promise<void> {
    const debouncedEvent = this.debouncedEvents.get(eventKey);
    if (!debouncedEvent) return;

    // Clear scheduled flush
    const timer = this.scheduledFlushes.get(eventKey);
    if (timer) {
      clearTimeout(timer);
      this.scheduledFlushes.delete(eventKey);
    }

    try {
      // Add consolidation metadata to event
      const consolidatedEvent: EventData = {
        ...debouncedEvent.latestEvent,
        properties: {
          ...debouncedEvent.latestEvent.properties,
          // Add debouncing metadata
          _debounced: true,
          _consolidatedCount: debouncedEvent.count,
          _consolidationWindow: Date.now() - debouncedEvent.firstTimestamp,
          _lastConsolidatedAt: new Date().toISOString(),
        },
      };

      this.logger.debug(
        `✅ Flushing consolidated event: ${eventKey} ` +
          `(${debouncedEvent.count} events, ${Date.now() - debouncedEvent.firstTimestamp}ms window)`,
      );

      // Execute callback with consolidated event
      await callback(consolidatedEvent);

      // Record metrics
      this.recordDebouncingMetrics(debouncedEvent);
    } catch (error) {
      this.logger.error(`Failed to flush debounced event ${eventKey}:`, error);
    } finally {
      // Clean up
      this.debouncedEvents.delete(eventKey);
    }
  }

  /**
   * Record debouncing performance metrics
   */
  private recordDebouncingMetrics(debouncedEvent: DebouncedEvent): void {
    const consolidationWindow = Date.now() - debouncedEvent.firstTimestamp;
    const consolidationRatio = debouncedEvent.count;

    // Log performance stats
    if (debouncedEvent.count > 10) {
      this.logger.log(
        `🎯 High consolidation achieved: ${debouncedEvent.eventKey} ` +
          `consolidated ${debouncedEvent.count} events in ${consolidationWindow}ms ` +
          `(${(((debouncedEvent.count - 1) / debouncedEvent.count) * 100).toFixed(1)}% reduction)`,
      );
    }
  }

  /**
   * Get debouncing statistics
   */
  getDebouncingStats() {
    const activeEvents = this.debouncedEvents.size;
    const scheduledFlushes = this.scheduledFlushes.size;

    const eventStats = Array.from(this.debouncedEvents.values()).map(
      (event) => ({
        eventKey: event.eventKey,
        count: event.count,
        windowMs: Date.now() - event.firstTimestamp,
        contactId: event.contactId,
      }),
    );

    return {
      activeEvents,
      scheduledFlushes,
      config: this.config,
      eventStats: eventStats.slice(0, 10), // Top 10 for debugging
      totalMemoryUsage: this.estimateMemoryUsage(),
    };
  }

  /**
   * Estimate memory usage of debouncer
   */
  private estimateMemoryUsage(): string {
    // Rough estimate: each debounced event ~1-2KB
    const estimatedBytes = this.debouncedEvents.size * 1500;
    if (estimatedBytes > 1024 * 1024) {
      return `${(estimatedBytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    return `${(estimatedBytes / 1024).toFixed(1)}KB`;
  }

  /**
   * Force flush all debounced events (for shutdown or testing)
   */
  async flushAll(
    callback: (consolidatedEvent: EventData) => Promise<void>,
  ): Promise<void> {
    this.logger.log(
      `🔄 Force flushing all debounced events (${this.debouncedEvents.size} events)`,
    );

    const flushPromises = Array.from(this.debouncedEvents.keys()).map(
      (eventKey) => this.flushDebouncedEvent(eventKey, callback),
    );

    await Promise.allSettled(flushPromises);
  }

  /**
   * Clear all debounced events without flushing (emergency cleanup)
   */
  clear(): void {
    this.logger.warn(
      `🧹 Clearing all debounced events without flushing (${this.debouncedEvents.size} events lost)`,
    );

    // Clear all timers
    this.scheduledFlushes.forEach((timer) => clearTimeout(timer));

    // Clear data
    this.debouncedEvents.clear();
    this.scheduledFlushes.clear();
  }
}
