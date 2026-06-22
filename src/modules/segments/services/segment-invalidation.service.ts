import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { SegmentQueueService } from './segment-queue.service';
import { Repository } from 'typeorm';
import { Segment } from '../entities/segment.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentInvalidationResult {
  segmentsInvalidated: string[];
  segmentsRecomputed: string[];
  processingTimeMs: number;
}

/**
 * Event-driven segment invalidation service following Dittofeed patterns
 * Automatically invalidates and recomputes segments when relevant events are received
 */
@Injectable()
export class SegmentInvalidationService {
  private readonly logger = new CustomLoggerService(
    SegmentInvalidationService.name,
  );

  constructor(
    private readonly clickhouseService: ClickHouseService,
    private readonly segmentQueueService: SegmentQueueService,
    private readonly db: TenantDbContext,
  ) {}

  private get segmentRepository(): Repository<Segment> {
    return this.db.getRepository(Segment);
  }

  /**
   * Check if a segment definition references a specific event
   * Similar to Dittofeed's segment definition parsing
   */
  private segmentReferencesEvent(
    segment: Segment,
    eventName: string,
    eventType: string,
  ): boolean {
    if (!segment.definition) return false;

    try {
      // Convert definition to string for pattern matching
      const definitionStr = JSON.stringify(segment.definition).toLowerCase();
      const eventNameLower = eventName?.toLowerCase() || '';
      const eventTypeLower = eventType?.toLowerCase() || '';

      // Check for direct event name references
      if (eventNameLower && definitionStr.includes(eventNameLower)) {
        return true;
      }

      // Check for event type references
      if (eventTypeLower && definitionStr.includes(eventTypeLower)) {
        return true;
      }

      // Check for wildcard patterns (e.g., "purchase_*")
      if (eventNameLower) {
        const eventParts = eventNameLower.split('_');
        for (const part of eventParts) {
          if (part.length > 2 && definitionStr.includes(part)) {
            return true;
          }
        }
      }

      // FIXED: Proper segment-event matching logic
      const definition =
        typeof segment.definition === 'string'
          ? JSON.parse(segment.definition)
          : segment.definition;

      // Check all nodes in the segment definition
      if (definition.nodes && Array.isArray(definition.nodes)) {
        for (const node of definition.nodes) {
          if (this.nodeReferencesEvent(node, eventName, eventType)) {
            return true;
          }
        }
      }

      // Check entry node for Everyone type
      if (definition.entryNode && definition.entryNode.type === 'Everyone') {
        // Everyone segments are affected by any contact change
        if (eventType === 'identify' && eventName === 'contact_updated') {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.warn(
        `Failed to parse segment definition for ${segment.id}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Check if a specific node references an event
   */
  private nodeReferencesEvent(
    node: any,
    eventName: string,
    eventType: string,
  ): boolean {
    if (!node || !node.type) return false;

    // For identify/contact_updated events, these node types should be invalidated:
    if (eventType === 'identify' && eventName === 'contact_updated') {
      switch (node.type) {
        case 'UserProperty':
          // UserProperty nodes are affected by contact updates
          return true;
        case 'Label':
          // Label nodes are affected by contact updates (labels can change)
          return true;
        case 'CustomAttribute':
          // CustomAttribute nodes are affected by contact updates
          return true;
        case 'Everyone':
          // Everyone segments are affected by any contact change
          return true;
        default:
          break;
      }
    }

    // For track events, check LastPerformed nodes
    if (eventType === 'track') {
      if (node.type === 'LastPerformed' && node.event === eventName) {
        return true;
      }
    }

    // For custom-attribute change events (accept both event-name forms, EVO-1839).
    // NOTE: this `nodeReferencesEvent` is only reached via `segmentReferencesEvent`
    // → `findAffectedSegments`, and every public method of this service
    // (findAffectedSegments / bulkInvalidateSegments / enqueueSegmentsForRecomputation)
    // currently has NO callers — the LIVE invalidation runs in `segment-job.service.ts`
    // and `atomic-processor.service.ts` (both fixed for EVO-1839). Kept in sync here
    // for hygiene; do not rely on this path.
    if (
      eventName === 'contact.custom_attribute.changed' ||
      eventName === 'custom_attribute_changed'
    ) {
      if (node.type === 'CustomAttribute') {
        return true;
      }
    }

    // Check for direct event name references in any node
    const nodeStr = JSON.stringify(node).toLowerCase();
    const eventNameLower = eventName?.toLowerCase() || '';

    if (eventNameLower && nodeStr.includes(eventNameLower)) {
      return true;
    }

    return false;
  }

  /**
   * Bulk invalidate segments for multiple contacts
   * Similar to Dittofeed's bulk operations
   */
  async bulkInvalidateSegments(
    segmentIds: string[],
    contactIds: string[],
  ): Promise<void> {
    if (segmentIds.length === 0 || contactIds.length === 0) return;

    try {
      // Remove assignments from cache in bulk
      const deleteQuery = `
        DELETE FROM computed_property_assignments_v2
        WHERE
          type = 'segment'
          AND computed_property_id IN {segmentIds:Array(String)}
          AND contact_id IN {contactIds:Array(String)}
      `;

      await this.clickhouseService.command({
        query: deleteQuery,
        parameters: {
          segmentIds,
          contactIds,
        },
      });

      // Mark segments for recomputation
      await this.segmentRepository
        .createQueryBuilder()
        .update(Segment)
        .set({ lastComputedAt: () => 'NULL' })
        .whereInIds(segmentIds)
        .execute();

      this.logger.log(
        `Bulk invalidated ${segmentIds.length} segments for ${contactIds.length} contacts`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to bulk invalidate segments: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Find affected segments without processing them (Dittofeed-style)
   */
  async findAffectedSegments(
    contactId: string,
    eventName: string,
  ): Promise<Segment[]> {
    this.logger.debug(
      `Finding segments affected by event: ${eventName} for contact: ${contactId}`,
    );

    try {
      const segments = await this.segmentRepository.find();

      // Filter segments that reference this event
      const affectedSegments = segments.filter((segment) =>
        this.segmentReferencesEvent(segment, eventName, 'track'),
      );

      this.logger.debug(
        `Found ${affectedSegments.length} affected segments: ${affectedSegments.map((s) => s?.id || 'undefined').join(', ')}`,
      );

      return affectedSegments;
    } catch (error) {
      this.logger.error(
        `Failed to find affected segments: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }

  /**
   * Enqueue segments for recomputation (Dittofeed-style)
   */
  async enqueueSegmentsForRecomputation(params: {
    segmentIds: string[];
    priority?: number;
  }): Promise<void> {
    this.logger.debug(
      `Enqueuing ${params.segmentIds.length} segments for recomputation with priority ${params.priority || 1}`,
    );

    try {
      await this.segmentQueueService.enqueueSegments({
        segmentIds: params.segmentIds,
        priority: params.priority || 1,
      });

      this.logger.debug(
        `✅ Successfully enqueued ${params.segmentIds.length} segments`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue segments: ${error.message}`,
        error.stack,
      );
      throw error;
    }
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
    return this.segmentQueueService.getQueueStats();
  }
}
