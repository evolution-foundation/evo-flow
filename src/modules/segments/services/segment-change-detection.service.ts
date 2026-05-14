import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { SegmentEventsService } from './segment-events.service';
import { SegmentStateManagementService } from './segment-state-management.service';
import { Segment } from '../entities/segment.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class SegmentChangeDetectionService {
  private readonly logger = new CustomLoggerService(
    SegmentChangeDetectionService.name,
  );

  constructor(
    private readonly clickhouseService: ClickHouseService,
    private readonly segmentEventsService: SegmentEventsService,
    private readonly stateManagement: SegmentStateManagementService,
  ) {}

  /**
   * Get current segment assignments from computed_property_assignments_v2
   */
  async getCurrentAssignments(
    segmentId: string,
  ): Promise<Record<string, boolean>> {
    try {
      const qb = this.clickhouseService.createQueryBuilder();
      const segmentIdParam = qb.addParameter(segmentId, 'String');

      const query = qb
        .addQueryPart(
          `
        SELECT DISTINCT
          contact_id,
          segment_value
        FROM evo_campaign.computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND computed_property_id = ${segmentIdParam}
      `,
        )
        .build();

      const results = await this.clickhouseService.query<{
        contact_id: string;
        segment_value: boolean;
      }>(query);

      const assignments: Record<string, boolean> = {};
      for (const row of results) {
        assignments[row.contact_id] = row.segment_value;
      }

      return assignments;
    } catch (error) {
      this.logger.error(
        `Error getting current assignments for segment ${segmentId}: ${(error as Error).message}`,
      );
      return {};
    }
  }

  /**
   * Process segment change events with proper state comparison
   */
  async processSegmentChangeEvents(
    segment: Segment,
    timestamp: number,
    preservedPreviousAssignments?: Record<string, boolean>,
  ): Promise<void> {
    try {
      this.logger.debug(
        `Processing segment change events for segment ${segment.name} (${segment.id})`,
      );

      // Check if there's previous state - if not, this is the first computation
      // EXCEPTION: If preservedPreviousAssignments is provided (for time window segments),
      // we always process events since we preserved state before cleanup
      const hasPreviousState =
        preservedPreviousAssignments !== undefined
          ? true // If preserved assignments provided, we have previous state (even if empty for first computation)
          : await this.stateManagement.hasPreviousSegmentState(segment.id);

      this.logger.debug(
        `Segment ${segment.id} previous state check: hasPreviousState=${hasPreviousState}, ` +
          `preservedAssignments=${preservedPreviousAssignments ? Object.keys(preservedPreviousAssignments).length : 'none'}`,
      );

      // Special case: For time-window segments with empty preserved assignments, this is the first computation
      if (
        preservedPreviousAssignments !== undefined &&
        Object.keys(preservedPreviousAssignments).length === 0
      ) {
        this.logger.debug(
          `Time-window segment ${segment.id} has empty preserved assignments - this is the first computation, skipping event generation`,
        );
        return; // Don't generate events for first computation
      }

      // For regular segments, skip if no previous state (first computation)
      if (!hasPreviousState) {
        this.logger.debug(
          `No previous state found for segment ${segment.id} - this is the first computation, skipping event generation`,
        );
        return; // Don't generate events for first computation
      }

      // Use preserved previous assignments if provided (for time window segments)
      // Otherwise, get previous assignments normally
      const previousAssignments =
        preservedPreviousAssignments ||
        (await this.stateManagement.getPreviousSegmentAssignments(segment.id));

      this.logger.debug(
        `Segment ${segment.id} previous assignments found: ${Object.keys(previousAssignments).length} contacts`,
      );

      // Get current assignments for comparison
      const currentAssignments = await this.getCurrentAssignments(segment.id);

      this.logger.debug(
        `Segment ${segment.id} current assignments found: ${Object.keys(currentAssignments).length} contacts`,
      );

      // Detect changes by comparing previous and current assignments
      const changes: Array<{
        contactId: string;
        previousValue: boolean;
        newValue: boolean;
      }> = [];

      // Check for contacts that entered or exited the segment
      const allContactIds = new Set([
        ...Object.keys(previousAssignments),
        ...Object.keys(currentAssignments),
      ]);

      for (const contactId of allContactIds) {
        const previousValue = previousAssignments[contactId] || false;
        const newValue = currentAssignments[contactId] || false;

        if (previousValue !== newValue) {
          changes.push({
            contactId,
            previousValue,
            newValue,
          });
        }
      }

      if (changes.length > 0) {
        this.logger.log(
          `Found ${changes.length} segment changes for ${segment.name}`,
        );

        // Process segment changes asynchronously to not block computation
        setImmediate(() => {
          this.segmentEventsService.processSegmentChangesAsync(
            segment.id,
            segment.name,
            changes,
          );
        });
      } else {
        this.logger.debug(`No segment changes detected for ${segment.name}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing segment change events for ${segment.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
