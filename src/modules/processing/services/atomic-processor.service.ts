import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import {
  Segment,
  AdvancedSegmentDefinition,
  SegmentNode,
  PerformedSegmentNode,
  LabelSegmentNode,
  isAdvancedDefinition,
} from '../../segments/entities/segment.entity';
import { SegmentCircuitBreakerService } from '../../segments/services/segment-circuit-breaker.service';
import { SegmentMetricsService } from '../../segments/metrics/segment-metrics.service';
import { SegmentCacheService } from '../../cache/services/segment-cache.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface EventData {
  contactId: string;
  eventName: string;
  eventTime: Date;
  properties?: Record<string, any>;
  userId?: string;
}

// Simplified: Use the original Segment entity with parsed definition
export interface AtomicSegment {
  id: string;
  name: string;
  contactsCount: number;
  definition: AdvancedSegmentDefinition; // Parsed from original JSON
}

export interface SingleContactUpdateResult {
  contactId: string;
  segmentId: string;
  previousValue: boolean;
  newValue: boolean;
  processingTime: number;
}

@Injectable()
export class AtomicSegmentProcessor {
  private readonly logger = new CustomLoggerService(
    AtomicSegmentProcessor.name,
  );
  private cachedAtomicSegments: AtomicSegment[] | null = null;
  private cachedAtomicSegmentsExpiresAt = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_PARALLEL_SEGMENTS = 5;
  private readonly LATENCY_THRESHOLD_MS = 2000;

  constructor(
    @InjectRepository(Segment)
    private readonly segmentRepository: Repository<Segment>,
    private readonly clickHouseService: ClickHouseService,
    private readonly circuitBreaker: SegmentCircuitBreakerService,
    private readonly metrics: SegmentMetricsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly segmentCacheService: SegmentCacheService,
  ) {}

  async processAtomicUpdate(event: EventData): Promise<void> {
    const startTime = Date.now();

    try {
      // Check circuit breaker
      if (!this.circuitBreaker.canExecute()) {
        this.logger.warn('Circuit breaker is open, skipping atomic processing');
        return;
      }

      // 1. Find atomic segments affected by this event
      const atomicSegments = await this.findAtomicSegments(event);

      if (atomicSegments.length === 0) {
        this.logger.debug(
          `No atomic segments found for event ${event.eventName}`,
        );
        return;
      }

      this.logger.log(
        `Processing ${atomicSegments.length} atomic segments for contact ${event.contactId}`,
      );

      // 2. Process segments - sequential for multiple segments to avoid ClickHouse race conditions
      const segmentsToProcess = atomicSegments.slice(
        0,
        this.MAX_PARALLEL_SEGMENTS,
      );

      let results: PromiseSettledResult<{
        contactId: string;
        segmentId: string;
        previousValue: boolean;
        newValue: boolean;
        processingTime: number;
      }>[];

      if (segmentsToProcess.length === 1) {
        // Single segment - can process immediately
        const result = await Promise.allSettled([
          this.updateSingleContactSegment(
            event.contactId,
            segmentsToProcess[0],
            event,
          ),
        ]);
        results = result;
      } else {
        // Multiple segments - process sequentially to avoid ClickHouse race conditions
        this.logger.debug(
          `Processing ${segmentsToProcess.length} segments sequentially to avoid race conditions`,
        );
        results = [];

        for (const segment of segmentsToProcess) {
          try {
            const result = await this.updateSingleContactSegment(
              event.contactId,
              segment,
              event,
            );
            results.push({ status: 'fulfilled' as const, value: result });
          } catch (error) {
            results.push({ status: 'rejected' as const, reason: error });
          }
        }
      }

      // 3. Handle results and metrics
      let successCount = 0;
      let errorCount = 0;

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          successCount++;

          // Emit segment change event for journeys/campaigns
          if (result.value.previousValue !== result.value.newValue) {
            await this.emitSegmentChange(
              result.value.contactId,
              result.value.segmentId,
              result.value.newValue,
            );
          }
        } else {
          errorCount++;
          this.logger.error(
            `Failed to process atomic segment ${segmentsToProcess[index].id}: ${result.reason}`,
          );
        }
      }

      const totalTime = Date.now() - startTime;

      // Record metrics
      this.metrics.recordAtomicProcessing({
        duration: totalTime,
        segmentCount: segmentsToProcess.length,
        successCount,
        errorCount,
        contactId: event.contactId,
        eventName: event.eventName,
      });

      // Check latency threshold for circuit breaker
      if (totalTime > this.LATENCY_THRESHOLD_MS) {
        this.circuitBreaker.recordFailure();
        this.logger.warn(
          `Atomic processing exceeded latency threshold: ${totalTime}ms`,
        );
      } else {
        this.circuitBreaker.recordSuccess();
      }

      this.logger.log(
        `Atomic processing completed in ${totalTime}ms: ${successCount} success, ${errorCount} errors`,
      );
    } catch (error) {
      const totalTime = Date.now() - startTime;
      this.circuitBreaker.recordFailure();
      this.metrics.recordAtomicProcessing({
        duration: totalTime,
        segmentCount: 0,
        successCount: 0,
        errorCount: 1,
        contactId: event.contactId,
        eventName: event.eventName,
      });

      this.logger.error('Failed to process atomic update', error);
      throw error;
    }
  }

  private async updateSingleContactSegment(
    contactId: string,
    segment: AtomicSegment,
    event: EventData,
  ): Promise<SingleContactUpdateResult> {
    const startTime = Date.now();

    try {
      // 1. Get current segment assignment to track changes
      const currentAssignment = await this.getCurrentSegmentAssignment(
        contactId,
        segment.id,
      );
      const previousValue = currentAssignment?.segment_value === 1;

      this.logger.debug(
        `🔍 ATOMIC processing segment ${segment.id} for contact ${contactId} - previousValue: ${previousValue}`,
      );

      // 2. 🎯 ATOMIC LOGIC: Process ONLY this specific contact, not the entire segment
      // Evaluate if this contact should be in the segment based on the event
      const shouldBeInSegment = await this.evaluateContactForSegment(
        contactId,
        segment,
        event,
      );

      this.logger.debug(
        `🔍 Contact ${contactId} evaluation for segment ${segment.id}: should be in segment = ${shouldBeInSegment}`,
      );

      // 3. Update ClickHouse assignment for this specific contact only
      await this.updateContactSegmentAssignment(
        contactId,
        segment.id,
        shouldBeInSegment,
      );

      // 4. Get final assignment to confirm change
      const newAssignment = await this.getCurrentSegmentAssignment(
        contactId,
        segment.id,
      );
      const newValue = !!newAssignment?.segment_value;
      const processingTime = Date.now() - startTime;

      // 5. If assignment changed, sync PostgreSQL counter (increment/decrement)
      const changed = previousValue !== newValue;
      if (changed) {
        await this.syncPostgreSQLCounterIncremental(
          segment.id,
          newValue ? 1 : -1, // +1 if added, -1 if removed
        );

        this.logger.debug(
          `📊 PostgreSQL counter updated for segment ${segment.id}: ${newValue ? '+1' : '-1'}`,
        );
      }

      this.logger.debug(
        `🔍 Assignment change: segment=${segment.id}, contact=${contactId}, ${previousValue} → ${newValue}`,
      );

      return {
        contactId,
        segmentId: segment.id,
        previousValue,
        newValue,
        processingTime,
      };
    } catch (error) {
      this.logger.error(
        `Failed to update single contact segment: contactId=${contactId}, segmentId=${segment.id}`,
        error,
      );
      throw error;
    }
  }

  private async findAtomicSegments(event: EventData): Promise<AtomicSegment[]> {
    const now = Date.now();

    if (this.cachedAtomicSegments && now < this.cachedAtomicSegmentsExpiresAt) {
      return this.filterSegmentsByEvent(this.cachedAtomicSegments, event.eventName);
    }

    try {
      const cachedSegments = await this.segmentCacheService.getAllSegments();

      const atomicSegments = cachedSegments
        .filter((cached) => this.isAtomicSegmentFromCache(cached))
        .map((cached) => ({
          id: cached.id,
          name: cached.name,
          contactsCount: cached.contactsCount || 0,
          definition: cached.definition,
        }));

      this.cachedAtomicSegments = atomicSegments;
      this.cachedAtomicSegmentsExpiresAt = now + this.CACHE_TTL;

      return this.filterSegmentsByEvent(atomicSegments, event.eventName);
    } catch (error) {
      this.logger.error('Failed to find atomic segments', error);
      return [];
    }
  }

  private mapToAtomicSegment(segment: Segment): AtomicSegment {
    const parsedDefinition = this.parseSegmentDefinition(segment.definition);

    return {
      id: segment.id,
      name: segment.name,
      contactsCount: segment.contactsCount,
      definition: parsedDefinition,
    };
  }

  private parseSegmentDefinition(definition: any): AdvancedSegmentDefinition {
    // Handle string definitions (parse JSON)
    if (typeof definition === 'string') {
      try {
        definition = JSON.parse(definition);
      } catch (error) {
        this.logger.warn('Failed to parse segment definition JSON', error);
        return this.createEveryoneDefinition();
      }
    }

    // Check if it's already in advanced format
    if (isAdvancedDefinition(definition)) {
      return definition;
    }

    // Handle legacy format or simple types
    if (definition.type === 'And' && definition.children) {
      return {
        nodes: definition.children || [],
        entryNode: {
          id: 'entry',
          type: 'And',
          children: definition.children?.map((child: any) => child.id) || [],
        },
      };
    }

    // Default fallback
    return this.createEveryoneDefinition();
  }

  private createEveryoneDefinition(): AdvancedSegmentDefinition {
    return {
      nodes: [],
      entryNode: {
        id: 'entry',
        type: 'Everyone',
      },
    };
  }

  private isAtomicSegmentFromCache(cached: any): boolean {
    // Check if it's atomic based on definition and contact count
    return (
      cached.definition &&
      typeof cached.definition === 'object' &&
      (cached.contactsCount || 0) <= 1000 // Small segments for real-time processing
    );
  }

  private isAtomicSegment(segment: Segment): boolean {
    // Basic checks
    if (!segment.definition || segment.contactsCount > 10000) {
      this.logger.debug(
        `Segment ${segment.id} (${segment.name}) rejected: no definition or too many contacts (${segment.contactsCount})`,
      );
      return false;
    }

    const parsedDefinition = this.parseSegmentDefinition(segment.definition);
    const complexity = this.calculateComplexity(parsedDefinition);
    const maxTimeWindow = this.getMaxTimeWindow(parsedDefinition);

    const isAtomic = this.isAtomicBasedOnComplexity(
      complexity,
      segment.contactsCount,
      maxTimeWindow,
    );

    this.logger.debug(
      `Segment ${segment.id} (${segment.name}): complexity=${complexity}, contacts=${segment.contactsCount}, timeWindow=${maxTimeWindow}s, isAtomic=${isAtomic}`,
    );

    return isAtomic;
  }

  private isAtomicBasedOnComplexity(
    complexity: number,
    contactsCount: number,
    maxTimeWindow: number,
  ): boolean {
    // Atomic criteria based on studies:
    // 1. Low complexity (< 3 nodes)
    // 2. Small contact count (< 1000)
    // 3. Recent time windows (< 7 days = 604800 seconds) OR no time window (0)

    const hasLowComplexity = complexity <= 2;
    const hasSmallContactCount = contactsCount < 1000;
    // 0 means no time window (always evaluate) which is good for atomic
    const hasRecentTimeWindow = maxTimeWindow === 0 || maxTimeWindow <= 604800; // No window or < 7 days

    // Must meet at least 2 out of 3 criteria
    const criteriaCount = [
      hasLowComplexity,
      hasSmallContactCount,
      hasRecentTimeWindow,
    ].filter(Boolean).length;

    return criteriaCount >= 2;
  }

  private calculateComplexity(definition: AdvancedSegmentDefinition): number {
    let complexity = 0;

    // Count nodes
    complexity += definition.nodes.length;

    // Add complexity for entry node type
    switch (definition.entryNode.type) {
      case 'Everyone':
        complexity += 0; // Simple
        break;
      case 'And':
      case 'Or':
        complexity += definition.entryNode.children?.length || 0;
        break;
    }

    // Add complexity for node types
    for (const node of definition.nodes) {
      switch (node.type) {
        case 'Performed':
          const performedNode = node as PerformedSegmentNode;
          complexity += 2; // Medium complexity
          complexity += performedNode.properties?.length || 0;
          break;
        case 'Label':
          complexity += 1; // Low complexity
          break;
        case 'Everyone':
          complexity += 0; // No complexity
          break;
        default:
          complexity += 1;
      }
    }

    return complexity;
  }

  private getMaxTimeWindow(definition: AdvancedSegmentDefinition): number {
    let maxTimeWindow = 0;

    for (const node of definition.nodes) {
      if (node.type === 'Performed') {
        const performedNode = node as PerformedSegmentNode;

        // Check withinSeconds (legacy)
        if (performedNode.withinSeconds) {
          maxTimeWindow = Math.max(maxTimeWindow, performedNode.withinSeconds);
        }

        // Check within.windowValue (new format)
        if (performedNode.within?.windowValue) {
          const seconds = this.parseTimeWindow(
            performedNode.within.windowValue,
          );
          maxTimeWindow = Math.max(maxTimeWindow, seconds);
        }
      }
    }

    // Default to 0 if no time window specified (means no time restriction)
    return maxTimeWindow;
  }

  private parseTimeWindow(windowValue: string): number {
    // Parse formats like "7d", "24h", "30m", etc.
    const match = windowValue.match(/(\d+)([dhm])/);
    if (!match) return 0;

    const [, value, unit] = match;
    const numValue = parseInt(value, 10);

    switch (unit) {
      case 'd':
        return numValue * 24 * 60 * 60; // days to seconds
      case 'h':
        return numValue * 60 * 60; // hours to seconds
      case 'm':
        return numValue * 60; // minutes to seconds
      default:
        return 0;
    }
  }

  private filterSegmentsByEvent(
    segments: AtomicSegment[],
    eventName: string,
  ): AtomicSegment[] {
    this.logger.debug(
      `Filtering ${segments.length} atomic segments for event: ${eventName}`,
    );

    const filtered = segments.filter((segment) => {
      const references = this.segmentReferencesEvent(segment, eventName);
      this.logger.debug(
        `Segment ${segment.id} (${segment.name}) references event ${eventName}: ${references}`,
      );
      return references;
    });

    this.logger.debug(
      `Filtered to ${filtered.length} segments for event ${eventName}`,
    );

    return filtered;
  }

  private segmentReferencesEvent(
    segment: AtomicSegment,
    eventName: string,
  ): boolean {
    const definition = segment.definition;

    // Check if any node references this event
    const isCustomAttributeEvent =
      eventName === 'contact.custom_attribute.changed' ||
      eventName === 'custom_attribute_changed';
    for (const node of definition.nodes) {
      if (node.type === 'Performed') {
        const performedNode = node as PerformedSegmentNode;
        if (performedNode.event === eventName) {
          return true;
        }
      }
      // identify-DTO custom-attribute change (EVO-1839): a CustomAttribute node is
      // affected when the attribute changes. Match explicitly rather than relying
      // on the eventType-coincidence in the trait-based fallback below.
      if (node.type === 'CustomAttribute' && isCustomAttributeEvent) {
        return true;
      }
    }

    // For Everyone segments, all events are relevant
    if (definition.entryNode.type === 'Everyone') {
      return true;
    }

    // For trait-based segments, identify/track events might be relevant
    if (['identify', 'track', 'page', 'screen'].includes(eventName)) {
      return true;
    }

    return false;
  }

  private buildSegmentLogicForBatch(segment: AtomicSegment): string {
    const definition = segment.definition;

    // Handle Everyone segments - use the exact same logic as batch system
    if (
      definition.entryNode.type === 'Everyone' &&
      definition.nodes.length === 0
    ) {
      return '1 = 1'; // Everyone always matches
    }

    // Handle single node segments
    if (definition.nodes.length === 1) {
      return this.buildNodeLogicForBatch(definition.nodes[0]);
    }

    // Handle multiple nodes with AND/OR logic
    const nodeLogics = definition.nodes.map((node) =>
      this.buildNodeLogicForBatch(node),
    );

    if (definition.entryNode.type === 'And') {
      return `(${nodeLogics.join(' AND ')})`;
    } else if (definition.entryNode.type === 'Or') {
      return `(${nodeLogics.join(' OR ')})`;
    }

    return '1 = 0'; // Never matches
  }

  private buildNodeLogicForBatch(node: SegmentNode): string {
    switch (node.type) {
      case 'Performed':
        const performedNode = node as PerformedSegmentNode;
        const eventName = performedNode.event;

        // Follow EXACT same logic as working batch system in performed-segment-builder.ts
        let condition = `event_name = '${eventName}'`;

        // Add property conditions - follow exact batch logic
        if (performedNode.properties && performedNode.properties.length > 0) {
          const propertyConditions = performedNode.properties
            .map((prop) => {
              return `JSONExtractString(properties, '${prop.path}') = '${prop.operator.value}'`;
            })
            .join(' AND ');

          condition = `event_name = '${eventName}' AND (${propertyConditions})`;
        }

        return condition;

      case 'Label':
        const labelNode = node as LabelSegmentNode;
        return `JSONExtractString(properties, 'label') ${labelNode.condition === 'has' ? '=' : '!='} '${labelNode.labelId}'`;

      case 'Everyone':
        return '1 = 1'; // Always matches

      default:
        return '1 = 0'; // Never matches
    }
  }

  private buildSegmentLogic(segment: AtomicSegment): string {
    const definition = segment.definition;

    // Handle Everyone segments
    if (
      definition.entryNode.type === 'Everyone' &&
      definition.nodes.length === 0
    ) {
      return '1'; // Everyone is always in the segment
    }

    // Handle single node segments
    if (definition.nodes.length === 1) {
      return this.buildNodeLogic(definition.nodes[0]);
    }

    // Handle multiple nodes with AND/OR logic
    const nodeLogics = definition.nodes.map((node) =>
      this.buildNodeLogic(node),
    );

    if (definition.entryNode.type === 'And') {
      return `CASE WHEN (${nodeLogics.join(' AND ')}) THEN 1 ELSE 0 END`;
    } else if (definition.entryNode.type === 'Or') {
      return `CASE WHEN (${nodeLogics.join(' OR ')}) THEN 1 ELSE 0 END`;
    }

    return '0';
  }

  private buildNodeLogic(node: SegmentNode): string {
    switch (node.type) {
      case 'Performed':
        const performedNode = node as PerformedSegmentNode;
        const eventName = performedNode.event;
        const times = performedNode.times || 1;
        const operator = this.mapTimesOperator(performedNode.timesOperator);

        let condition = `countIf(event_name = '${eventName}') ${operator} ${times}`;

        // Add property conditions
        if (performedNode.properties && performedNode.properties.length > 0) {
          const propertyConditions = performedNode.properties
            .map((prop) => {
              return `JSONExtractString(properties, '${prop.path}') = '${prop.operator.value}'`;
            })
            .join(' AND ');

          condition = `countIf(event_name = '${eventName}' AND ${propertyConditions}) ${operator} ${times}`;
        }

        return condition;

      case 'Label':
        const labelNode = node as LabelSegmentNode;
        return `JSONExtractString(properties, 'label') ${labelNode.condition === 'has' ? '=' : '!='} '${labelNode.labelId}'`;

      case 'Everyone':
        return '1 = 1'; // Always true

      default:
        return '1 = 1'; // Default to true for unknown node types
    }
  }

  private mapTimesOperator(operator?: string): string {
    switch (operator) {
      case 'GreaterThan':
      case '>':
        return '>';
      case 'LessThan':
      case '<':
        return '<';
      case 'Equals':
      case '=':
        return '=';
      case 'GreaterThanOrEqual':
      case '>=':
      default:
        return '>=';
    }
  }

  private getTimeWindowSeconds(segment: AtomicSegment): number {
    // Calculate max time window from definition in seconds (for INTERVAL SECOND)
    const calculatedWindow = this.getMaxTimeWindow(segment.definition);

    // 🔧 CRITICAL FIX: Use EXACTLY the same logic as cron/segment-worker
    // No buffer added - atomic should match cron exactly
    const finalWindow = calculatedWindow;

    // 🚨 DEBUGGING: Log the time window calculation
    this.logger.log(`🔍 TIME WINDOW DEBUG for segment ${segment.id}:`);
    this.logger.log(`🔍 Segment name: ${segment.name}`);
    this.logger.log(`🔍 Calculated window: ${calculatedWindow} seconds`);
    this.logger.log(`🔍 Buffer added: 0 seconds (matching cron logic)`);
    this.logger.log(`🔍 Final window: ${finalWindow} seconds`);

    return finalWindow;
  }

  private async getCurrentSegmentAssignment(
    contactId: string,
    segmentId: string,
  ): Promise<{ segment_value: number } | null> {
    try {
      const query = `
        SELECT segment_value
        FROM computed_property_assignments_v2
        WHERE contact_id = '${contactId}'
          AND computed_property_id = '${segmentId}'
        ORDER BY assigned_at DESC
        LIMIT 1
      `;

      const result = await this.clickHouseService.query({ query });
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      this.logger.warn(
        `Failed to get current segment assignment: ${error.message}`,
      );
      return null;
    }
  }

  private async emitSegmentChange(
    contactId: string,
    segmentId: string,
    newValue: boolean,
  ): Promise<void> {
    try {
      this.eventEmitter.emit('segment.assignment.changed', {
        contactId,
        segmentId,
        isAssigned: newValue,
        timestamp: new Date(),
        processingType: 'atomic',
      });

      this.logger.debug(
        `Emitted segment change event: contact=${contactId}, segment=${segmentId}, assigned=${newValue}`,
      );
    } catch (error) {
      this.logger.error('Failed to emit segment change event', error);
    }
  }

  // Cache management methods
  clearCache(): void {
    this.cachedAtomicSegments = null;
    this.cachedAtomicSegmentsExpiresAt = 0;
    this.logger.log('Cleared atomic segments cache');
  }

  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cachedAtomicSegments ? this.cachedAtomicSegments.length : 0,
      keys: this.cachedAtomicSegments
        ? this.cachedAtomicSegments.map((s) => s.id)
        : [],
    };
  }

  /**
   * 🎯 Evaluate if a specific contact should be in a segment based on event
   */
  private async evaluateContactForSegment(
    contactId: string,
    segment: AtomicSegment,
    event: EventData,
  ): Promise<boolean> {
    try {
      const segmentLogic = this.buildSegmentLogicForBatch(segment);
      const timeWindowSeconds = this.getTimeWindowSeconds(segment);

      // Build time window filter
      const timeWindowFilter =
        timeWindowSeconds > 0
          ? `AND ce.occurred_at >= now() - INTERVAL ${timeWindowSeconds} SECOND`
          : ''; // No time restriction for segments without time window

      // Query to check if this contact meets segment criteria
      const query = `
        SELECT 1 as meets_criteria
        FROM evo_campaign.contact_events ce
        WHERE
          ce.contact_or_anonymous_id = '${contactId}'
          AND (${segmentLogic})
          AND ce.processing_time <= now()
          ${timeWindowFilter}
        LIMIT 1
      `;

      const result = await this.clickHouseService.query({ query });
      const meetsCriteria = result.length > 0;

      this.logger.debug(
        `🔍 Contact ${contactId} meets criteria for segment ${segment.id}: ${meetsCriteria}`,
      );

      return meetsCriteria;
    } catch (error) {
      this.logger.error(
        `Failed to evaluate contact ${contactId} for segment ${segment.id}:`,
        error,
      );
      return false; // Fail safe - don't assign on error
    }
  }

  /**
   * 🎯 Update ClickHouse assignment for a specific contact
   */
  private async updateContactSegmentAssignment(
    contactId: string,
    segmentId: string,
    shouldBeInSegment: boolean,
  ): Promise<void> {
    try {
      // Insert new assignment record
      const assignmentRecord = {
        computed_property_id: segmentId,
        contact_id: contactId,
        type: 'segment',
        segment_value: shouldBeInSegment ? 1 : 0,
        assigned_at: new Date().toISOString(),
      };

      await this.clickHouseService.insert({
        table: 'computed_property_assignments_v2',
        values: [assignmentRecord],
        format: 'JSONEachRow',
      });

      this.logger.debug(
        `📝 Updated assignment for contact ${contactId} in segment ${segmentId}: ${shouldBeInSegment}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update contact assignment: contactId=${contactId}, segmentId=${segmentId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * 🔄 Sync PostgreSQL counter with incremental change (ATOMIC)
   */
  private async syncPostgreSQLCounterIncremental(
    segmentId: string,
    increment: number, // +1 or -1
  ): Promise<void> {
    try {
      // CRITICAL: Invalidate cache BEFORE updating PostgreSQL to prevent race condition
      await this.invalidateSegmentCache(segmentId);

      // Use SQL to increment/decrement the counter atomically
      await this.segmentRepository.query(
        'UPDATE segments SET contacts_count = GREATEST(contacts_count + $1, 0), last_computed_at = NOW() WHERE id = $2',
        [increment, segmentId],
      );

      this.logger.debug(
        `🔄 PostgreSQL incremental update: segment ${segmentId} count ${increment > 0 ? '+' : ''}${increment}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync PostgreSQL incremental counter for segment ${segmentId}:`,
        error,
      );
      // Don't throw - this is a sync operation, main atomic processing should continue
    }
  }

  /**
   * 🗑️ Invalidate segment cache after counter update
   */
  private async invalidateSegmentCache(segmentId: string): Promise<void> {
    try {
      await this.segmentCacheService.invalidateSegment(segmentId);
      this.logger.debug(`Cache invalidated for segment ${segmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to invalidate cache for segment ${segmentId}:`,
        error,
      );
    }
  }

  /**
   * Get processing statistics
   */
  getProcessingStats(): any {
    return {
      cacheSize: this.cachedAtomicSegments ? this.cachedAtomicSegments.length : 0,
      maxParallelSegments: this.MAX_PARALLEL_SEGMENTS,
      latencyThresholdMs: this.LATENCY_THRESHOLD_MS,
      cacheTTL: this.CACHE_TTL,
      circuitBreakerStatus: this.circuitBreaker.canExecute()
        ? 'CLOSED'
        : 'OPEN',
    };
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
