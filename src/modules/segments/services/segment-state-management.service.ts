import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { Segment } from '../entities/segment.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class SegmentStateManagementService {
  private readonly logger = new CustomLoggerService(
    SegmentStateManagementService.name,
  );

  constructor(private readonly clickhouseService: ClickHouseService) {}

  /**
   * Check if segment has previous state data
   */
  async hasPreviousSegmentState(segmentId: string): Promise<boolean> {
    try {
      const qb = this.clickhouseService.createQueryBuilder();
      const segmentIdParam = qb.addParameter(segmentId, 'String');

      const query = `
        SELECT count(*) as count
        FROM evo_campaign.resolved_segment_state FINAL
        WHERE
          segment_id = ${segmentIdParam}
          AND state_id = 'final'
      `;

      const result = await this.clickhouseService.query({
        query,
        parameters: qb.build().parameters,
      });

      const count = result[0]?.count || 0;
      return count > 0;
    } catch (error) {
      this.logger.error(
        `Error checking previous segment state for segment ${segmentId}: ${(error as Error).message}`,
      );
      return false; // Assume no previous state on error
    }
  }

  /**
   * Get previous segment assignments from resolved_segment_state
   */
  async getPreviousSegmentAssignments(
    segmentId: string,
  ): Promise<Record<string, boolean>> {
    try {
      const qb = this.clickhouseService.createQueryBuilder();
      const segmentIdParam = qb.addParameter(segmentId, 'String');

      const query = `
        SELECT
          contact_id,
          segment_state_value
        FROM evo_campaign.resolved_segment_state FINAL
        WHERE
          segment_id = ${segmentIdParam}
          AND state_id = 'final'
      `;

      const result = await this.clickhouseService.query({
        query,
        parameters: qb.build().parameters,
      });

      const assignments: Record<string, boolean> = {};
      for (const row of result) {
        assignments[row.contact_id] = Boolean(row.segment_state_value);
      }

      this.logger.debug(
        `Found ${Object.keys(assignments).length} previous assignments from resolved_segment_state for segment ${segmentId}`,
      );

      return assignments;
    } catch (error) {
      this.logger.error(
        `Error getting previous assignments for segment ${segmentId}: ${(error as Error).message}`,
      );
      return {}; // Return empty on error
    }
  }

  /**
   * Save resolved segment state to final table
   */
  async saveResolvedSegmentState(
    segment: Segment,
    timestamp: number,
  ): Promise<void> {
    try {
      this.logger.debug(
        `Saving resolved segment state for segment ${segment.id}`,
      );

      const qb = this.clickhouseService.createQueryBuilder();
      const segmentIdParam = qb.addParameter(segment.id, 'String');
      const timestampParam = qb.addParameter(timestamp / 1000, 'Float64');

      const query = `
        INSERT INTO evo_campaign.resolved_segment_state
        SELECT
          computed_property_id as segment_id,
          'final' as state_id,
          contact_id,
          segment_value as segment_state_value,
          max_event_time,
          toDateTime64(${timestampParam}, 3) as computed_at
        FROM evo_campaign.computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND computed_property_id = ${segmentIdParam}
      `;

      await this.clickhouseService.query({
        query,
        parameters: qb.build().parameters,
      });

      this.logger.debug(
        `Successfully saved resolved segment state for segment ${segment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error saving resolved segment state for segment ${segment.id}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Cleanup method - EXACTLY like backup
   */
  async cleanupOldSegmentData(segmentId: string): Promise<void> {
    try {
      this.logger.log(`Cleaning up old segment data for segment ${segmentId}`);

      const qb = this.clickhouseService.createQueryBuilder();
      const segmentIdParam = qb.addParameter(segmentId, 'String');

      // Use parametrized queries to avoid SQL injection and syntax errors
      const deleteStateQuery = qb
        .addQueryPart(
          `DELETE FROM evo_campaign.computed_property_state_v2 WHERE computed_property_id = ${segmentIdParam}`,
        )
        .build();

      await this.clickhouseService.command({
        query: deleteStateQuery.query,
        parameters: deleteStateQuery.parameters,
      });

      // Cleanup assignments
      const qb2 = this.clickhouseService.createQueryBuilder();
      const segmentIdParam2 = qb2.addParameter(segmentId, 'String');

      const deleteAssignmentsQuery = qb2
        .addQueryPart(
          `DELETE FROM evo_campaign.computed_property_assignments_v2 WHERE computed_property_id = ${segmentIdParam2}`,
        )
        .build();

      await this.clickhouseService.command({
        query: deleteAssignmentsQuery.query,
        parameters: deleteAssignmentsQuery.parameters,
      });

      // Cleanup resolved state
      const qb3 = this.clickhouseService.createQueryBuilder();
      const segmentIdParam3 = qb3.addParameter(segmentId, 'String');

      const deleteResolvedQuery = qb3
        .addQueryPart(
          `DELETE FROM evo_campaign.resolved_segment_state WHERE segment_id = ${segmentIdParam3}`,
        )
        .build();

      await this.clickhouseService.command({
        query: deleteResolvedQuery.query,
        parameters: deleteResolvedQuery.parameters,
      });

      this.logger.log(
        `Successfully cleaned up all old data for segment ${segmentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to cleanup old segment data for segment ${segmentId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
