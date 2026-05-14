import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { Segment } from '../entities/segment.entity';
import {
  SegmentNode,
  SegmentNodeType,
  AndSegmentNode,
  OrSegmentNode,
} from '../entities/segment.entity';
import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class SegmentAssignmentService {
  private readonly logger = new CustomLoggerService(
    SegmentAssignmentService.name,
  );

  constructor(
    private readonly clickHouseService: ClickHouseService,
    private readonly queryBuilder: SegmentClickHouseQueryBuilderService,
  ) {}

  async computeAssignments(
    segment: Segment,
    definition: any,
    now: number,
  ): Promise<void> {
    this.logger.debug(
      `[STAGE 2] Computing assignments for segment ${segment.id}`,
    );

    const nowSeconds = now / 1000;

    const assignmentConfig = this.resolvedSegmentToAssignment(
      segment,
      definition.entryNode,
      definition,
    );

    const query = `
      INSERT INTO evo_campaign.computed_property_assignments_v2
      SELECT
        'segment',
        segment_id,
        contact_id,
        ${assignmentConfig.expression} as segment_value,
        '',
        max_state_event_time,
        toDateTime64(${nowSeconds}, 3) as assigned_at
      FROM (
        SELECT
          segment_id,
          contact_id,
          CAST((groupArray(state_id), groupArray(segment_state_value)), 'Map(String, Boolean)') as state_values,
          max(max_state_event_time) as max_state_event_time
        FROM (
          SELECT
            computed_property_id as segment_id,
            state_id,
            contact_id,
            argMaxMerge(last_value) != '' as segment_state_value,
            max(event_time) as max_state_event_time
          FROM evo_campaign.computed_property_state_v2
          WHERE
            type = 'segment'
            AND computed_property_id = '${segment.id}'
            AND computed_at <= toDateTime64(${nowSeconds}, 3)
            AND state_id IN (${assignmentConfig.stateIds.map((id) => `'${id}'`).join(', ')})
          GROUP BY
            computed_property_id,
            contact_id,
            state_id
        )
        GROUP BY
          segment_id,
          contact_id
      )
    `;

    await this.clickHouseService.query({ query });

    this.logger.debug(`Computed assignments for segment ${segment.id}`);
  }

  private resolvedSegmentToAssignment(
    segment: Segment,
    node: SegmentNode,
    definition?: any,
  ): { stateIds: string[]; expression: string } {
    const stateId = this.queryBuilder.generateStateId(segment, node.id);

    switch (node.type) {
      case SegmentNodeType.Email:
      case SegmentNodeType.UserProperty:
      case SegmentNodeType.Performed:
      case SegmentNodeType.LastPerformed:
      case SegmentNodeType.WhatsApp:
      case SegmentNodeType.Everyone:
      case SegmentNodeType.Label:
      case SegmentNodeType.CustomAttribute: {
        return {
          stateIds: [stateId],
          expression: `state_values['${stateId}']`,
        };
      }

      case SegmentNodeType.And: {
        const andNode = node as AndSegmentNode;
        if (!andNode.children || andNode.children.length === 0) {
          return { stateIds: [], expression: 'false' };
        }

        const childConfigs = andNode.children.map((childId) => {
          const childNode = definition?.nodes?.find(
            (n: any) => n.id === childId,
          );
          if (childNode) {
            return this.resolvedSegmentToAssignment(
              segment,
              childNode,
              definition,
            );
          }
          return { stateIds: [], expression: 'false' };
        });

        const allStateIds = childConfigs.flatMap((config) => config!.stateIds);
        const expressions = childConfigs.map((config) => config!.expression);

        return {
          stateIds: allStateIds,
          expression:
            expressions.length > 0 ? expressions.join(' AND ') : 'false',
        };
      }

      case SegmentNodeType.Or: {
        const orNode = node as OrSegmentNode;
        if (!orNode.children || orNode.children.length === 0) {
          return { stateIds: [], expression: 'false' };
        }

        const childConfigs = orNode.children.map((childId) => {
          const childNode = definition?.nodes?.find(
            (n: any) => n.id === childId,
          );
          if (childNode) {
            return this.resolvedSegmentToAssignment(
              segment,
              childNode,
              definition,
            );
          }
          return { stateIds: [], expression: 'false' };
        });

        const allStateIds = childConfigs.flatMap((config) => config!.stateIds);
        const expressions = childConfigs.map((config) => config!.expression);

        return {
          stateIds: allStateIds,
          expression:
            expressions.length > 0 ? expressions.join(' OR ') : 'false',
        };
      }

      default:
        this.logger.warn(`Unsupported assignment node type: ${node.type}`);
        return { stateIds: [], expression: 'false' };
    }
  }

  async countFinalAssignments(segmentId: string): Promise<{
    contactsAdded: number;
    contactsRemoved: number;
    totalContacts: number;
  }> {
    try {
      const query = `
        SELECT
          countIf(segment_value = true) as contacts_currently_in_segment,
          countIf(segment_value = false) as contacts_currently_out_segment,
          count() as total_contacts_evaluated
        FROM (
          SELECT DISTINCT
            contact_id,
            segment_value
          FROM evo_campaign.computed_property_assignments_v2 FINAL
          WHERE
            type = 'segment'
            AND computed_property_id = '${segmentId}'
        )
      `;

      const result = await this.clickHouseService.query({ query });
      const row = result[0] || {
        contacts_currently_in_segment: 0,
        contacts_currently_out_segment: 0,
        total_contacts_evaluated: 0,
      };

      this.logger.debug(
        `[COUNT] Segment ${segmentId} results: ${row.contacts_currently_in_segment} in segment, ${row.contacts_currently_out_segment} out of segment`,
      );

      return {
        contactsAdded: 0,
        contactsRemoved: 0,
        totalContacts: row.contacts_currently_in_segment || 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to count final assignments for segment ${segmentId}: ${(error as Error).message}`,
      );
      return {
        contactsAdded: 0,
        contactsRemoved: 0,
        totalContacts: 0,
      };
    }
  }
}
