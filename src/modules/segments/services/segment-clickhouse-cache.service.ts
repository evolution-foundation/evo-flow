import { Injectable, OnModuleInit } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentCacheAssignment {
  segmentId: string;
  contactId: string;
  inSegment: boolean;
  assignedAt: Date;
  maxEventTime: Date;
}

export interface SegmentCacheResult {
  assignments: SegmentCacheAssignment[];
  fromCache: boolean;
  computedAt: Date;
}

/**
 * ClickHouse-based segment cache service
 * Uses computed_property_assignments_v2 table for high-performance segment lookups
 */
@Injectable()
export class SegmentCacheService implements OnModuleInit {
  private readonly logger = new CustomLoggerService(SegmentCacheService.name);

  constructor(private readonly clickhouseService: ClickHouseService) {}

  async onModuleInit() {
    this.logger.log('SegmentCacheService initialized');
  }

  /**
   * Get segment assignments for a contact from ClickHouse cache
   */
  async getContactSegmentAssignments(
    contactId: string,
    segmentIds?: string[],
  ): Promise<SegmentCacheResult> {
    try {
      let query = `
        SELECT
          computed_property_id as segmentId,
          contact_id as contactId,
          segment_value as inSegment,
          assigned_at as assignedAt,
          max_event_time as maxEventTime
        FROM computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND contact_id = {contactId:String}
      `;

      const parameters: Record<string, any> = {
        contactId,
      };

      if (segmentIds && segmentIds.length > 0) {
        query += ` AND computed_property_id IN {segmentIds:Array(String)}`;
        parameters.segmentIds = segmentIds;
      }

      query += ` ORDER BY assigned_at DESC`;

      const results = await this.clickhouseService.query<{
        segmentId: string;
        contactId: string;
        inSegment: boolean;
        assignedAt: string;
        maxEventTime: string;
      }>({
        query,
        parameters,
      });

      const assignments: SegmentCacheAssignment[] = results.map((row) => ({
        segmentId: row.segmentId,
        contactId: row.contactId,
        inSegment: row.inSegment,
        assignedAt: new Date(row.assignedAt),
        maxEventTime: new Date(row.maxEventTime),
      }));

      return {
        assignments,
        fromCache: true,
        computedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get segment assignments from cache: ${error.message}`,
        error.stack,
      );
      return {
        assignments: [],
        fromCache: false,
        computedAt: new Date(),
      };
    }
  }

  /**
   * Check if a contact is in a specific segment (cached lookup)
   */
  async isContactInSegment(
    contactId: string,
    segmentId: string,
  ): Promise<boolean> {
    try {
      const query = `
        SELECT segment_value as inSegment
        FROM computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND computed_property_id = {segmentId:String}
          AND contact_id = {contactId:String}
        LIMIT 1
      `;

      const results = await this.clickhouseService.query<{
        inSegment: boolean;
      }>({
        query,
        parameters: {
          segmentId,
          contactId,
        },
      });

      return results.length > 0 ? results[0].inSegment : false;
    } catch (error) {
      this.logger.error(
        `Failed to check segment assignment from cache: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get all contacts in a segment from cache
   */
  async getSegmentContacts(
    segmentId: string,
    limit: number = 1000,
    offset: number = 0,
  ): Promise<{
    contactIds: string[];
    total: number;
    fromCache: boolean;
  }> {
    try {
      const countQuery = `
        SELECT count(DISTINCT contact_id) as total
        FROM computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND computed_property_id = {segmentId:String}
          AND segment_value = true
      `;

      const countResult = await this.clickhouseService.query<{
        total: number;
      }>({
        query: countQuery,
        parameters: { segmentId },
      });

      const total = countResult[0]?.total || 0;

      const dataQuery = `
        SELECT DISTINCT contact_id as contactId
        FROM computed_property_assignments_v2 FINAL
        WHERE
          type = 'segment'
          AND computed_property_id = {segmentId:String}
          AND segment_value = true
        ORDER BY contactId
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `;

      const dataResult = await this.clickhouseService.query<{
        contactId: string;
      }>({
        query: dataQuery,
        parameters: {
          segmentId,
          limit,
          offset,
        },
      });

      return {
        contactIds: dataResult.map((row) => row.contactId),
        total,
        fromCache: true,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get segment contacts from cache: ${error.message}`,
      );
      return {
        contactIds: [],
        total: 0,
        fromCache: false,
      };
    }
  }

  /**
   * Update segment assignment in ClickHouse cache
   */
  async updateSegmentAssignment(
    segmentId: string,
    contactId: string,
    inSegment: boolean,
    maxEventTime?: Date,
  ): Promise<void> {
    try {
      const now = new Date();
      const eventTime = maxEventTime || now;

      const record = {
        type: 'segment',
        computed_property_id: segmentId,
        contact_id: contactId,
        segment_value: inSegment,
        contact_property_value: '',
        max_event_time: eventTime.toISOString(),
        assigned_at: now.toISOString(),
      };

      await this.clickhouseService.insert({
        table: 'computed_property_assignments_v2',
        values: [record],
        asyncInsert: true,
      });

      this.logger.debug(
        `Updated segment assignment in cache: ${segmentId} -> ${contactId} = ${inSegment}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update segment assignment in cache: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Batch update segment assignments in ClickHouse
   */
  async batchUpdateSegmentAssignments(
    assignments: Array<{
      segmentId: string;
      contactId: string;
      inSegment: boolean;
      maxEventTime?: Date;
    }>,
  ): Promise<void> {
    if (assignments.length === 0) return;

    try {
      const now = new Date();
      const records = assignments.map((assignment) => ({
        type: 'segment',
        computed_property_id: assignment.segmentId,
        contact_id: assignment.contactId,
        segment_value: assignment.inSegment,
        contact_property_value: '',
        max_event_time: (assignment.maxEventTime || now).toISOString(),
        assigned_at: now.toISOString(),
      }));

      await this.clickhouseService.insert({
        table: 'computed_property_assignments_v2',
        values: records,
        asyncInsert: true,
      });

      this.logger.log(
        `Batch updated ${assignments.length} segment assignments in cache`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to batch update segment assignments: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Invalidate segment cache for a specific segment
   */
  async invalidateSegmentCache(segmentId: string): Promise<void> {
    try {
      const deleteQuery = `
        DELETE FROM computed_property_assignments_v2
        WHERE
          type = 'segment'
          AND computed_property_id = {segmentId:String}
      `;

      await this.clickhouseService.command({
        query: deleteQuery,
        parameters: {
          segmentId,
        },
      });

      const deleteResolvedQuery = `
        DELETE FROM resolved_segment_state
        WHERE
          segment_id = {segmentId:String}
      `;

      await this.clickhouseService.command({
        query: deleteResolvedQuery,
        parameters: {
          segmentId,
        },
      });

      this.logger.log(`Invalidated cache for segment ${segmentId}`);
    } catch (error) {
      this.logger.error(
        `Failed to invalidate segment cache: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
