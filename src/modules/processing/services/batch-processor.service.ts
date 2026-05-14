import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventData } from '../interfaces/event-data.interface';
import { getProcessingConfig } from '../config/processing.config';
import { WriteMode } from '../enums/write-mode.enum';
import { Segment } from '../../segments/entities/segment.entity';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { SegmentCircuitBreakerService } from '../../segments/services/segment-circuit-breaker.service';
import { SegmentMetricsService } from '../../segments/metrics/segment-metrics.service';
import { SegmentCacheService } from '../../cache/services/segment-cache.service';
import { AtomicSegmentProcessor } from './atomic-processor.service';
import { IntelligentDebouncerService } from './intelligent-debouncer.service';
import { DeadLetterQueueService } from './dead-letter-queue.service';
import { BatchDatabaseOptimizerService } from './batch-database-optimizer.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface BatchEvent {
  eventData: EventData;
  timestamp: number;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
}

interface BatchSegment {
  id: string;
  name: string;
  contactsCount: number;
  definition: any;
  complexity: number;
}

@Injectable()
export class BatchProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(BatchProcessorService.name);
  private readonly config = getProcessingConfig();

  // 🚀 NEW BATCH SEGMENT ARCHITECTURE - SPRINT 2
  // Configuration constants
  private readonly MAX_BUFFER_SIZE = 10000; // Max events in buffer
  private readonly BATCH_SIZE_SMALL = 5000; // Contacts per batch (small segments)
  private readonly BATCH_SIZE_LARGE = 10000; // Contacts per batch (large segments)
  private readonly FLUSH_INTERVAL_HIGH = 5000; // 5s for high priority
  private readonly FLUSH_INTERVAL_NORMAL = 15000; // 15s for normal priority
  private readonly FLUSH_INTERVAL_LOW = 30000; // 30s for low priority
  private readonly MAX_CONCURRENT_BATCHES = 5; // Parallel batch processing limit
  private readonly LATENCY_THRESHOLD_MS = 30000; // 30s max latency for circuit breaker

  // 🚀 ENHANCED CIRCUIT BREAKER PROTECTION
  private readonly MEMORY_THRESHOLD_MB = 500; // Max memory before circuit break
  private readonly MAX_PROCESSING_JOBS = 5; // Max concurrent jobs before circuit break

  // Event buffer system (NEW)
  private readonly eventBuffer = new Map<string, BatchEvent[]>(); // segmentId -> events
  private readonly scheduledJobs = new Map<string, NodeJS.Timeout>(); // segmentId -> timer
  private readonly processingJobs = new Set<string>(); // segmentIds being processed
  private cachedSegments: BatchSegment[] | null = null;
  private cachedSegmentsExpiresAt = 0;

  // Memory monitoring (NEW)
  private bufferMemoryUsage = 0;
  private readonly MAX_MEMORY_MB = 100; // 100MB max buffer size

  // Legacy batch processing (KEEP FOR BACKWARD COMPATIBILITY)
  private batchQueue: EventData[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly BATCH_SIZE = this.config.batchSize || 1000;
  private readonly BATCH_TIMEOUT_MS = 5000;
  private readonly MAX_BATCH_MEMORY = 10 * 1024 * 1024;

  constructor(
    @InjectRepository(Segment)
    private segmentRepository: Repository<Segment>,
    private clickhouseService: ClickHouseService,
    private circuitBreaker: SegmentCircuitBreakerService,
    private metrics: SegmentMetricsService,
    private eventEmitter: EventEmitter2,
    private segmentCacheService: SegmentCacheService,
    private atomicProcessor: AtomicSegmentProcessor,
    private debouncer: IntelligentDebouncerService,
    private dlqService: DeadLetterQueueService,
    private dbOptimizer: BatchDatabaseOptimizerService,
  ) {
    this.logger.log(
      '🚀 BatchSegmentProcessor initialized with intelligent buffering',
    );
  }

  async onModuleInit() {
    // Initialize both legacy and new batch processing
    if (this.shouldUseBatching()) {
      this.logger.log(
        `Legacy batch processor initialized with size: ${this.BATCH_SIZE}, timeout: ${this.BATCH_TIMEOUT_MS}ms`,
      );
      this.startBatchTimer();
    }

    // Initialize new segment-based batch processing
    this.logger.log(
      `🚀 Segment batch processing initialized - Target: < 30s for medium segments (1K-100K contacts)`,
    );

    // Start periodic buffer cleanup
    setInterval(() => this.cleanupExpiredBuffers(), 60000); // Every minute
  }

  async onModuleDestroy() {
    this.logger.log('🛑 BatchSegmentProcessor shutting down...');

    // Clear all scheduled segment jobs
    this.scheduledJobs.forEach((timer) => clearTimeout(timer));
    this.scheduledJobs.clear();

    // Process remaining segment events
    await this.flushAllSegmentBuffers();

    // Legacy batch processing cleanup
    if (this.batchQueue.length > 0) {
      this.logger.log('Flushing remaining legacy batch before shutdown...');
      await this.flushBatch();
    }

    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.logger.log('✅ BatchSegmentProcessor shutdown complete');
  }

  // 🚀 NEW SEGMENT-BASED BATCH PROCESSING API

  /**
   * Main entry point: Queue event for intelligent batch segment processing
   */
  async queueEventForBatchSegmentProcessing(event: EventData): Promise<void> {
    try {
      // 🚀 ENHANCED CIRCUIT BREAKER CHECKS
      if (!this.circuitBreaker.canExecute()) {
        this.logger.warn(
          'Circuit breaker is open, skipping batch segment processing',
        );
        return;
      }

      // Check system resources before processing
      if (!this.checkSystemResources()) {
        this.logger.warn(
          'System resources exhausted, skipping batch processing',
        );
        this.circuitBreaker.recordFailure();
        return;
      }

      // Find batch segments affected by this event
      const batchSegments = await this.findBatchSegments(event);

      if (batchSegments.length === 0) {
        this.logger.debug(
          `No batch segments found for event ${event.eventName}`,
        );
        return;
      }

      // 🚀 INTELLIGENT DEBOUNCING: Consolidate similar events before batch processing
      await this.debouncer.debounceEvent(event, async (consolidatedEvent) => {
        // Queue consolidated event for each affected segment with intelligent buffering
        for (const segment of batchSegments) {
          await this.queueEventForSegment(segment, consolidatedEvent);
        }
      });

      this.logger.debug(
        `Event ${event.eventName} queued for ${batchSegments.length} batch segments`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to queue event for batch segment processing: ${error.message}`,
      );
      this.circuitBreaker.recordFailure();

      // 🚨 Send to Dead Letter Queue for retry handling
      await this.dlqService.handleFailedEvent(event, error, {
        processingType: 'BATCH',
        attemptedAt: new Date().toISOString(),
      });

      throw error;
    }
  }

  private shouldUseBatching(): boolean {
    return [WriteMode.CH_ASYNC, WriteMode.KAFKA].includes(
      this.config.writeMode,
    );
  }

  // 🚀 NEW SEGMENT PROCESSING METHODS

  /**
   * Queue event for specific segment with intelligent buffering and debouncing
   */
  private async queueEventForSegment(
    segment: BatchSegment,
    event: EventData,
  ): Promise<void> {
    const bufferKey = segment.id;

    // Check memory limits
    if (this.bufferMemoryUsage > this.MAX_MEMORY_MB * 1024 * 1024) {
      this.logger.warn('Buffer memory limit reached, forcing flush');
      await this.forceFlushOldestBuffer();
    }

    // Create batch event with priority
    const batchEvent: BatchEvent = {
      eventData: event,
      timestamp: Date.now(),
      priority: this.calculateEventPriority(event, segment),
    };

    // Add to buffer
    if (!this.eventBuffer.has(bufferKey)) {
      this.eventBuffer.set(bufferKey, []);
    }

    const buffer = this.eventBuffer.get(bufferKey)!;
    buffer.push(batchEvent);

    // Update memory usage
    this.bufferMemoryUsage += this.estimateEventSize(batchEvent);

    // Check if we need immediate flush (buffer full)
    if (buffer.length >= this.MAX_BUFFER_SIZE) {
      this.logger.debug(`Buffer full for segment ${segment.id}, forcing flush`);
      await this.flushSegmentBuffer(segment.id);
      return;
    }

    // Schedule delayed flush if not already scheduled (INTELLIGENT DEBOUNCING)
    if (!this.scheduledJobs.has(bufferKey)) {
      const flushDelay = this.calculateFlushDelay(batchEvent.priority, segment);

      const timer = setTimeout(async () => {
        await this.flushSegmentBuffer(segment.id);
      }, flushDelay);

      this.scheduledJobs.set(bufferKey, timer);

      this.logger.debug(
        `🕐 Scheduled flush for segment ${segment.name} in ${flushDelay}ms (priority: ${batchEvent.priority}, contacts: ${segment.contactsCount})`,
      );
    }
  }

  /**
   * Calculate event priority for intelligent scheduling
   */
  private calculateEventPriority(
    event: EventData,
    segment: BatchSegment,
  ): 'HIGH' | 'NORMAL' | 'LOW' {
    // High priority events (business critical)
    const highPriorityEvents = [
      'identify',
      'purchase',
      'subscription_created',
      'payment_completed',
      'trial_started',
      'upgrade',
      'contact_updated',
      'message_created',
    ];

    // Critical segment indicators
    const isCriticalSegment =
      segment.contactsCount < 10000 ||
      segment.name.includes('vip') ||
      segment.name.includes('priority') ||
      segment.name.includes('hot');

    if (
      (event.eventName && highPriorityEvents.includes(event.eventName)) ||
      isCriticalSegment
    ) {
      return 'HIGH';
    }

    // Low priority for large segments
    if (segment.contactsCount > 50000) {
      return 'LOW';
    }

    return 'NORMAL';
  }

  /**
   * Calculate flush delay based on priority and segment characteristics (INTELLIGENT DEBOUNCING)
   */
  private calculateFlushDelay(
    priority: 'HIGH' | 'NORMAL' | 'LOW',
    segment: BatchSegment,
  ): number {
    const baseDelay = {
      HIGH: this.FLUSH_INTERVAL_HIGH, // 5s
      NORMAL: this.FLUSH_INTERVAL_NORMAL, // 15s
      LOW: this.FLUSH_INTERVAL_LOW, // 30s
    }[priority];

    // Adjust delay based on segment size (smaller segments flush faster)
    const sizeMultiplier =
      segment.contactsCount < 5000
        ? 0.5
        : segment.contactsCount > 50000
          ? 1.5
          : 1.0;

    return Math.round(baseDelay * sizeMultiplier);
  }

  /**
   * Flush specific segment buffer (CORE BATCH PROCESSING)
   */
  private async flushSegmentBuffer(segmentId: string): Promise<void> {
    const startTime = Date.now();

    try {
      // Clear scheduled timer
      const timer = this.scheduledJobs.get(segmentId);
      if (timer) {
        clearTimeout(timer);
        this.scheduledJobs.delete(segmentId);
      }

      // Get events from buffer
      const events = this.eventBuffer.get(segmentId) || [];
      if (events.length === 0) {
        return;
      }

      // Clear buffer and update memory usage
      this.eventBuffer.delete(segmentId);
      this.bufferMemoryUsage -= events.reduce(
        (sum, event) => sum + this.estimateEventSize(event),
        0,
      );

      // Skip if already processing
      if (this.processingJobs.has(segmentId)) {
        this.logger.debug(
          `Segment ${segmentId} already being processed, skipping`,
        );
        return;
      }

      this.processingJobs.add(segmentId);

      this.logger.log(
        `🔄 Batch processing ${events.length} events for segment ${segmentId}`,
      );

      // Get segment info from cache (single-account)
      const segment =
        (await this.getSegmentByIdCached(segmentId)) ??
        (await this.getSegmentById(segmentId));
      if (!segment) {
        this.logger.warn(
          `Segment ${segmentId} not found, skipping batch processing`,
        );
        return;
      }

      // Process batch segment (CORE LOGIC)
      await this.processBatchSegment(segment, events);

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Batch segment processed: ${segment.name} in ${duration}ms`,
      );

      // Record metrics
      this.metrics.recordBatchProcessing({
        duration,
        segmentId,
        eventCount: events.length,
        contactsCount: segment.contactsCount,
        batchSize: this.calculateBatchSize(segment.contactsCount),
      });

      // Check latency threshold for circuit breaker
      if (duration > this.LATENCY_THRESHOLD_MS) {
        this.circuitBreaker.recordFailure();
        this.logger.warn(
          `Batch processing exceeded latency threshold: ${duration}ms`,
        );
      } else {
        this.circuitBreaker.recordSuccess();
      }
    } catch (error) {
      this.logger.error(
        `Failed to flush segment buffer ${segmentId}: ${error.message}`,
      );
      this.circuitBreaker.recordFailure();

      // 🚨 Send failed events to DLQ for retry (get events from buffer)
      const failedEvents = this.eventBuffer.get(segmentId) || [];
      for (const batchEvent of failedEvents) {
        await this.dlqService.handleFailedEvent(batchEvent.eventData, error, {
          segmentId,
          processingType: 'BATCH',
          attemptedAt: new Date().toISOString(),
        });
      }

      throw error;
    } finally {
      this.processingJobs.delete(segmentId);
    }
  }

  // 📊 LEGACY API (KEEP FOR BACKWARD COMPATIBILITY)

  /**
   * Add event to legacy batch queue
   */
  async addToBatch(eventData: EventData): Promise<void> {
    if (!this.shouldUseBatching()) {
      // For sync modes, skip batching but don't save directly
      // Events are already sent to Kafka queue in ProcessingService
      return;
    }

    this.batchQueue.push(eventData);

    // Check if we should flush based on size
    if (this.shouldFlushBySize()) {
      this.logger.debug(
        `Legacy batch size reached (${this.batchQueue.length}), flushing...`,
      );
      await this.flushBatch();
    } else if (this.shouldFlushByMemory()) {
      this.logger.debug('Legacy batch memory limit reached, flushing...');
      await this.flushBatch();
    }
  }

  /**
   * Start timer to periodically flush batches
   */
  private startBatchTimer() {
    this.batchTimer = setInterval(async () => {
      if (this.batchQueue.length > 0 && !this.isProcessing) {
        this.logger.debug(
          `Batch timer triggered with ${this.batchQueue.length} events`,
        );
        await this.flushBatch();
      }
    }, this.BATCH_TIMEOUT_MS);
  }

  /**
   * Check if batch should be flushed based on size
   */
  private shouldFlushBySize(): boolean {
    return this.batchQueue.length >= this.BATCH_SIZE;
  }

  /**
   * Check if batch should be flushed based on memory usage
   */
  private shouldFlushByMemory(): boolean {
    const estimatedSize = JSON.stringify(this.batchQueue).length;
    return estimatedSize > this.MAX_BATCH_MEMORY;
  }

  /**
   * Flush current batch to storage
   */
  async flushBatch(): Promise<void> {
    if (this.isProcessing || this.batchQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const batch = [...this.batchQueue];
    this.batchQueue = [];

    try {
      const startTime = Date.now();

      // Legacy batch processing - events are already in Kafka queue
      // This is for legacy batch processing that doesn't go through segment logic
      // In the new hybrid architecture, this should be rarely used
      this.logger.debug(
        `⚠️  Legacy batch flush: ${batch.length} events (consider migrating to segment-based processing)`,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Batch of ${batch.length} events flushed in ${duration}ms`,
      );

      // Emit metrics
      this.emitBatchMetrics(batch.length, duration);
    } catch (error) {
      this.logger.error(`Failed to flush batch: ${error.message}`, error.stack);

      // Retry logic - put events back in queue
      if (this.shouldRetry(error)) {
        this.logger.warn('Retrying batch...');
        this.batchQueue.unshift(...batch);
      } else {
        // Log failed events for manual recovery
        this.logFailedBatch(batch, error);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Determine if we should retry based on error type
   */
  private shouldRetry(error: any): boolean {
    // Retry on connection errors, timeouts, etc.
    const retryableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'Connection lost',
    ];

    return retryableErrors.some(
      (msg) => error.message?.includes(msg) || error.code === msg,
    );
  }

  /**
   * Log failed batch for manual recovery
   */
  private logFailedBatch(batch: EventData[], error: any) {
    this.logger.error(
      `BATCH_FAILURE: ${batch.length} events failed to process`,
      {
        error: error.message,
        eventIds: batch.map((e) => e.messageId),
        timestamp: new Date().toISOString(),
      },
    );
  }

  /**
   * Emit batch processing metrics
   */
  private emitBatchMetrics(size: number, duration: number) {
    // In production, this would send to monitoring system
    this.logger.debug('Batch metrics', {
      size,
      duration,
      throughput: Math.round((size / duration) * 1000), // events per second
      queueSize: this.batchQueue.length,
    });
  }

  // 🚀 NEW BATCH SEGMENT HELPER METHODS

  /**
   * Core batch segment processing logic
   */
  private async processBatchSegment(
    segment: BatchSegment,
    events: BatchEvent[],
  ): Promise<void> {
    const batchSize = this.calculateBatchSize(segment.contactsCount);
    const affectedContacts = this.extractUniqueContacts(events);
    const totalContacts = Math.min(
      affectedContacts.length,
      segment.contactsCount,
    );
    const batches = Math.ceil(totalContacts / batchSize);

    this.logger.debug(
      `Processing segment ${segment.name} in ${batches} batches of ${batchSize} contacts each`,
    );

    // Process in optimized chunks
    for (let i = 0; i < batches; i++) {
      const offset = i * batchSize;
      const contactsChunk = affectedContacts.slice(offset, offset + batchSize);

      await this.processBatchChunk(segment, contactsChunk);

      // Small delay between batches to prevent overwhelming ClickHouse
      if (i < batches - 1) {
        await this.sleep(50);
      }
    }

    // Emit segment change events for affected contacts
    for (const contactId of affectedContacts) {
      await this.emitSegmentChange(contactId, segment.id);
    }

    // Sync PostgreSQL counters after processing all batches
    try {
      const currentCount = await this.getCurrentSegmentCount(segment.id);
      await this.syncPostgreSQLCounterForSegment(segment.id, currentCount);

      this.logger.debug(
        `📊 BATCH processed segment ${segment.id}: ${affectedContacts.length} contacts processed, ${currentCount} total in segment`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync PostgreSQL after batch processing segment ${segment.id}:`,
        error,
      );
    }
  }

  /**
   * Process single batch chunk with optimized ClickHouse query
   */
  private async processBatchChunk(
    segment: BatchSegment,
    contactIds: string[],
  ): Promise<void> {
    if (contactIds.length === 0) return;

    // Build segment logic from definition
    const segmentLogic = this.buildSegmentLogic(segment.definition);

    const contactsFilter = contactIds.map((c) => `'${c}'`).join(',');

    const query = `
      INSERT INTO computed_property_assignments_v2
      (computed_property_id, contact_id, type, segment_value, assigned_at)
      SELECT DISTINCT
        '${segment.id}' as computed_property_id,
        ce.contact_or_anonymous_id as contact_id,
        'segment' as type,
        CASE
          WHEN ${segmentLogic} THEN 1
          ELSE 0
        END as segment_value,
        now() as assigned_at
      FROM evo_campaign.contact_events ce
      WHERE ce.contact_or_anonymous_id IN (${contactsFilter})
        AND ce.processing_time <= now()
      GROUP BY ce.contact_or_anonymous_id
    `;

    await this.clickhouseService.query({ query });
  }

  /**
   * Find batch segments affected by event
   */
  private async findBatchSegments(event: EventData): Promise<BatchSegment[]> {
    const now = Date.now();

    if (!this.cachedSegments || now > this.cachedSegmentsExpiresAt) {
      const allCached = await this.segmentCacheService.getAllSegments();

      this.cachedSegments = allCached
        .filter((cached) => this.isBatchSegmentFromCache(cached))
        .map((cached) => this.mapCachedToBatchSegment(cached));

      this.cachedSegmentsExpiresAt = now + 5 * 60 * 1000;
    }

    return this.cachedSegments.filter((segment) =>
      this.segmentReferencesEvent(segment, event.eventName || ''),
    );
  }

  /**
   * Check if cached segment qualifies for batch processing
   */
  private isBatchSegmentFromCache(cached: any): boolean {
    const contactsCount = cached.contactsCount || 0;
    return (
      cached.definition &&
      typeof cached.definition === 'object' &&
      contactsCount >= 1000 && // Medium segments
      contactsCount <= 100000 // Not too large
    );
  }

  /**
   * Check if segment qualifies for batch processing
   */
  private isBatchSegment(segment: any): boolean {
    const contactCount = segment.contactsCount || 0;

    // Batch criteria: 1K - 100K contacts (medium segments)
    // Too small -> ATOMIC, Too large -> CRON
    return contactCount >= 1000 && contactCount <= 100000;
  }

  /**
   * Build segment logic from definition (enhanced version)
   */
  private buildSegmentLogic(definition: any): string {
    if (typeof definition === 'string') {
      try {
        definition = JSON.parse(definition);
      } catch {
        return '1'; // Default to true for invalid definitions
      }
    }

    // Handle Everyone type - always true
    if (definition.entryNode?.type === 'Everyone') {
      return '1';
    }

    // Handle node-based definitions
    if (definition.nodes?.length > 0) {
      const node = definition.nodes[0];

      if (node.type === 'Performed') {
        const eventName = node.event || node.value;
        let logic = `ce.event_name = '${eventName}'`;

        // Add property filters
        if (node.properties) {
          for (const prop of node.properties) {
            logic += ` AND JSONExtractString(ce.properties, '${prop.key}') = '${prop.value}'`;
          }
        }

        // Add time window
        if (node.withinSeconds && node.withinSeconds > 0) {
          logic += ` AND ce.occurred_at >= now() - INTERVAL ${node.withinSeconds} SECOND`;
        }

        return logic;
      }

      if (node.type === 'Label') {
        const labelId = node.labelId || node.value;
        return `EXISTS(
          SELECT 1 FROM contact_labels cl 
          WHERE cl.contact_id = ce.contact_or_anonymous_id 
          AND cl.label_id = '${labelId}'
        )`;
      }
    }

    return '1'; // Default fallback
  }

  // Utility methods
  private extractUniqueContacts(events: BatchEvent[]): string[] {
    const contacts = new Set<string>();
    for (const event of events) {
      if (event.eventData.contactId) {
        contacts.add(event.eventData.contactId);
      }
    }
    return Array.from(contacts);
  }

  private calculateBatchSize(contactsCount: number): number {
    if (contactsCount < 10000) {
      return this.BATCH_SIZE_SMALL; // 5K for smaller segments
    }
    return this.BATCH_SIZE_LARGE; // 10K for larger segments
  }

  private mapCachedToBatchSegment(cached: any): BatchSegment {
    return {
      id: cached.id,
      name: cached.name,
      definition: cached.definition,
      contactsCount: cached.contactsCount || 0,
      complexity: this.calculateComplexity(cached.definition),
    };
  }

  private mapToBatchSegment(segment: any): BatchSegment {
    return {
      id: segment.id,
      name: segment.name,
      contactsCount: segment.contactsCount || 0,
      definition: segment.definition,
      complexity: this.calculateComplexity(segment.definition),
    };
  }

  private calculateComplexity(definition: any): number {
    if (!definition) return 1;

    if (typeof definition === 'string') {
      try {
        definition = JSON.parse(definition);
      } catch {
        return 1;
      }
    }

    const nodeCount = definition.nodes?.length || 1;
    const hasTimeConstraints = definition.nodes?.some(
      (node: any) => node.withinSeconds,
    )
      ? 1
      : 0;
    const hasProperties = definition.nodes?.some(
      (node: any) => node.properties?.length > 0,
    )
      ? 1
      : 0;

    return nodeCount + hasTimeConstraints + hasProperties;
  }

  private segmentReferencesEvent(
    segment: BatchSegment,
    eventName: string,
  ): boolean {
    const definitionStr = JSON.stringify(segment.definition).toLowerCase();
    return (
      definitionStr.includes(eventName.toLowerCase()) ||
      definitionStr.includes('everyone') ||
      definitionStr.includes('performed')
    );
  }

  // Get segment by ID using cache
  private async getSegmentByIdCached(
    segmentId: string,
  ): Promise<BatchSegment | null> {
    try {
      const cachedSegment = await this.segmentCacheService.getSegment(segmentId);

      if (cachedSegment) {
        return {
          id: cachedSegment.id,
          name: cachedSegment.name,
          definition: cachedSegment.definition,
          contactsCount: cachedSegment.contactsCount || 0,
          complexity: this.calculateComplexity(cachedSegment.definition),
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to get segment ${segmentId} from cache: ${error.message}`);
      return this.getSegmentById(segmentId);
    }
  }

  private async getSegmentById(
    segmentId: string,
  ): Promise<BatchSegment | null> {
    try {
      const segment = await this.segmentRepository.findOne({
        where: { id: segmentId },
        select: ['id', 'name', 'definition', 'contactsCount'],
      });

      return segment ? this.mapToBatchSegment(segment) : null;
    } catch (error) {
      this.logger.error(`Failed to get segment ${segmentId}: ${error.message}`);
      return null;
    }
  }

  private async flushAllSegmentBuffers(): Promise<void> {
    const segmentIds = Array.from(this.eventBuffer.keys());

    this.logger.log(
      `Flushing ${segmentIds.length} remaining segment buffers...`,
    );

    await Promise.all(
      segmentIds.map((segmentId) => this.flushSegmentBuffer(segmentId)),
    );
  }

  private async forceFlushOldestBuffer(): Promise<void> {
    let oldestSegmentId = '';
    let oldestTimestamp = Date.now();

    for (const [segmentId, events] of this.eventBuffer.entries()) {
      const bufferAge = Math.min(...events.map((e) => e.timestamp));
      if (bufferAge < oldestTimestamp) {
        oldestTimestamp = bufferAge;
        oldestSegmentId = segmentId;
      }
    }

    if (oldestSegmentId) {
      this.logger.warn(`Force flushing oldest buffer: ${oldestSegmentId}`);
      await this.flushSegmentBuffer(oldestSegmentId);
    }
  }

  private cleanupExpiredBuffers(): void {
    const now = Date.now();
    const expiredThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [segmentId, events] of this.eventBuffer.entries()) {
      const oldestEvent = Math.min(...events.map((e) => e.timestamp));

      if (now - oldestEvent > expiredThreshold) {
        this.logger.debug(`Cleaning up expired buffer: ${segmentId}`);
        this.flushSegmentBuffer(segmentId).catch((error) =>
          this.logger.error(
            `Failed to cleanup expired buffer ${segmentId}: ${error.message}`,
          ),
        );
      }
    }
  }

  private estimateEventSize(event: BatchEvent): number {
    return JSON.stringify(event).length * 2;
  }

  private async emitSegmentChange(
    contactId: string,
    segmentId: string,
  ): Promise<void> {
    this.eventEmitter.emit('segment.assignment.changed', {
      contactId,
      segmentId,
      timestamp: Date.now(),
      source: 'batch_processor',
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 🚀 ENHANCED CIRCUIT BREAKER: Check system resources
   * Returns false if system is under stress and should circuit break
   */
  private checkSystemResources(): boolean {
    try {
      // 1. Check concurrent processing jobs
      if (this.processingJobs.size >= this.MAX_PROCESSING_JOBS) {
        this.logger.warn(
          `Too many concurrent batch jobs: ${this.processingJobs.size}/${this.MAX_PROCESSING_JOBS}`,
        );
        return false;
      }

      // 2. Check buffer memory usage
      const bufferMemoryMB = Math.round(this.bufferMemoryUsage / 1024 / 1024);
      if (bufferMemoryMB >= this.MEMORY_THRESHOLD_MB) {
        this.logger.warn(
          `Buffer memory usage too high: ${bufferMemoryMB}MB/${this.MEMORY_THRESHOLD_MB}MB`,
        );
        return false;
      }

      // 3. Check Node.js memory usage
      const memoryUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      const maxHeapMB = 2048; // 2GB typical Node.js limit

      if (heapUsedMB > maxHeapMB * 0.8) {
        // 80% threshold
        this.logger.warn(
          `Node.js heap usage critical: ${heapUsedMB}MB (80% of ${maxHeapMB}MB limit)`,
        );
        return false;
      }

      // 4. Check buffer count (prevent unbounded growth)
      if (this.eventBuffer.size > 1000) {
        this.logger.warn(
          `Too many active segment buffers: ${this.eventBuffer.size}/1000`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`Error checking system resources: ${error.message}`);
      return false; // Fail safe
    }
  }

  /**
   * Get current processing statistics (NEW)
   */
  getProcessingStats(): any {
    return {
      // New batch segment stats
      segmentBuffers: this.eventBuffer.size,
      scheduledJobs: this.scheduledJobs.size,
      processingJobs: this.processingJobs.size,
      bufferMemoryUsageMB: Math.round(this.bufferMemoryUsage / 1024 / 1024),
      segmentCacheSize: this.cachedSegments ? this.cachedSegments.length : 0,

      // Intelligent debouncing stats
      debouncing: this.debouncer.getDebouncingStats(),

      // Dead Letter Queue stats
      deadLetterQueue: this.dlqService.getDLQStats(),

      // Database optimization stats
      databaseOptimization: this.dbOptimizer.getOptimizationStats(),

      // Legacy batch stats
      legacyQueueSize: this.batchQueue.length,
      legacyIsProcessing: this.isProcessing,
      legacyBatchSize: this.BATCH_SIZE,
      writeMode: this.config.writeMode,
      batchingEnabled: this.shouldUseBatching(),
    };
  }

  /**
   * Get current batch status (LEGACY - KEPT FOR COMPATIBILITY)
   */
  getBatchStatus() {
    return {
      queueSize: this.batchQueue.length,
      isProcessing: this.isProcessing,
      batchSize: this.BATCH_SIZE,
      writeMode: this.config.writeMode,
      batchingEnabled: this.shouldUseBatching(),
    };
  }

  /**
   * 🔄 Sync PostgreSQL contacts_count after BATCH segment processing
   */
  private async syncPostgreSQLCounterForSegment(
    segmentId: string,
    newContactsCount: number,
  ): Promise<void> {
    try {
      await this.segmentRepository.update(segmentId, {
        lastComputedAt: new Date(),
        contactsCount: newContactsCount,
      });

      this.logger.debug(
        `PostgreSQL BATCH sync: segment ${segmentId} count set to ${newContactsCount}`,
      );

      await this.segmentCacheService.invalidateSegment(segmentId);
      this.eventEmitter.emit('segment.computed', { segmentId });

      this.logger.debug(
        `Cache invalidated and computed event emitted for segment ${segmentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync PostgreSQL counter for segment ${segmentId}:`,
        error,
      );
    }
  }

  /**
   * Count current contacts in ClickHouse for a segment (BATCH)
   */
  private async getCurrentSegmentCount(segmentId: string): Promise<number> {
    try {
      const query = `
        SELECT COUNT(DISTINCT contact_id) as contact_count
        FROM computed_property_assignments_v2 FINAL
        WHERE computed_property_id = '${segmentId}'
          AND type = 'segment'
          AND segment_value = 1
      `;

      const result = await this.clickhouseService.query({ query });
      return result[0]?.contact_count || 0;
    } catch (error) {
      this.logger.warn(
        `Failed to get current segment count for ${segmentId}:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * Validate if a string is a valid UUID format
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }
}
