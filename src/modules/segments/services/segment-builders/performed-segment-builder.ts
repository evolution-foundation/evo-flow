import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class PerformedSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'value']);

    if (node.type === 'performed') {
      return this.buildPerformedQuery(node);
    } else if (node.type === 'lastPerformed') {
      return this.buildLastPerformedQuery(node);
    }

    throw new Error(`Unsupported performed node type: ${node.type}`);
  }

  private async buildPerformedQuery(
    node: SegmentNode,
  ): Promise<SegmentQueryResult> {
    const eventName = node.value;
    const { withinDays, operator, propertyFilters } = node;

    let query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = '${eventName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
    `;

    if (withinDays) {
      query += ` AND ce.created_at >= now() - INTERVAL ${withinDays} DAY`;
    }

    if (propertyFilters && propertyFilters.length > 0) {
      const propertyConditions = this.buildPropertyFilters(propertyFilters);
      query += ` AND ${propertyConditions}`;
    }

    if (operator === 'moreThan' && node.times) {
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) > ${node.times}
      `;
    } else if (operator === 'lessThan' && node.times) {
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) < ${node.times}
      `;
    } else if (operator === 'exactly' && node.times) {
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) = ${node.times}
      `;
    } else {
      query += ` GROUP BY ce.contact_id`;
    }

    this.logQuery(query, 'Performed');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildLastPerformedQuery(
    node: SegmentNode,
  ): Promise<SegmentQueryResult> {
    const eventName = node.value;
    const { withinDays, propertyFilters } = node;

    let query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = '${eventName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
        AND ce.created_at = (
          SELECT MAX(ce2.created_at)
          FROM evo_campaign.contact_events ce2
          WHERE ce2.contact_id = ce.contact_id
            AND ce2.event_name = '${eventName}'
        )
    `;

    if (withinDays) {
      query += ` AND ce.created_at >= now() - INTERVAL ${withinDays} DAY`;
    }

    if (propertyFilters && propertyFilters.length > 0) {
      const propertyConditions = this.buildPropertyFilters(propertyFilters);
      query += ` AND ${propertyConditions}`;
    }

    query += ` GROUP BY ce.contact_id`;

    this.logQuery(query, 'LastPerformed');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private buildPropertyFilters(propertyFilters: any[]): string {
    const conditions = propertyFilters.map((filter) => {
      const { key, operator, value } = filter;

      switch (operator) {
        case 'equals':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') = '${value}'`;
        case 'not_equals':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') != '${value}'`;
        case 'contains':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') LIKE '%${value}%'`;
        case 'not_contains':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') NOT LIKE '%${value}%'`;
        case 'is_known':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') IS NOT NULL AND JSON_EXTRACT_STRING(ce.properties, '${key}') != ''`;
        case 'is_unknown':
          return `JSON_EXTRACT_STRING(ce.properties, '${key}') IS NULL OR JSON_EXTRACT_STRING(ce.properties, '${key}') = ''`;
        case 'greater_than':
          return `toFloat64OrNull(JSON_EXTRACT_STRING(ce.properties, '${key}')) > ${value}`;
        case 'less_than':
          return `toFloat64OrNull(JSON_EXTRACT_STRING(ce.properties, '${key}')) < ${value}`;
        default:
          throw new Error(`Unsupported property filter operator: ${operator}`);
      }
    });

    return conditions.join(' AND ');
  }
}
