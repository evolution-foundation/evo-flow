import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

// ClickHouse SQL safety. Escape backslash first (it's the escape character in
// single-quoted string literals), THEN single quote — order matters or a `\\`
// followed by `'` collapses into `\\''` which ClickHouse reads as `\\` + `'`,
// leaving the closing quote ambiguous.
function escapeSqlString(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function assertInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${field}: expected integer, got ${String(value)}`);
  }
  return n;
}

function assertFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${field}: expected finite number, got ${String(value)}`);
  }
  return n;
}

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
    const eventName = escapeSqlString(node.value);
    const { withinDays, operator, propertyFilters } = node;

    // GROUP BY contact_id already deduplicates — no need for SELECT DISTINCT.
    let query = `
      SELECT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = '${eventName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
    `;

    if (withinDays) {
      const days = assertInt(withinDays, 'withinDays');
      query += ` AND ce.occurred_at >= now() - INTERVAL ${days} DAY`;
    }

    if (propertyFilters && propertyFilters.length > 0) {
      const propertyConditions = this.buildPropertyFilters(propertyFilters);
      query += ` AND ${propertyConditions}`;
    }

    if (operator === 'moreThan' && node.times) {
      const times = assertInt(node.times, 'times');
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) > ${times}
      `;
    } else if (operator === 'lessThan' && node.times) {
      const times = assertInt(node.times, 'times');
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) < ${times}
      `;
    } else if (operator === 'exactly' && node.times) {
      const times = assertInt(node.times, 'times');
      query += `
        GROUP BY ce.contact_id
        HAVING COUNT(*) = ${times}
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
    const eventName = escapeSqlString(node.value);
    const { withinDays, propertyFilters } = node;

    let query = `
      SELECT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = '${eventName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
        AND ce.occurred_at = (
          SELECT MAX(ce2.occurred_at)
          FROM evo_campaign.contact_events ce2
          WHERE ce2.contact_id = ce.contact_id
            AND ce2.event_name = '${eventName}'
        )
    `;

    if (withinDays) {
      const days = assertInt(withinDays, 'withinDays');
      query += ` AND ce.occurred_at >= now() - INTERVAL ${days} DAY`;
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
      const k = escapeSqlString(key);
      const v = escapeSqlString(value);

      switch (operator) {
        case 'equals':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') = '${v}'`;
        case 'not_equals':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') != '${v}'`;
        case 'contains':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') LIKE '%${v}%'`;
        case 'not_contains':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') NOT LIKE '%${v}%'`;
        case 'is_known':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') IS NOT NULL AND JSON_EXTRACT_STRING(ce.properties, '${k}') != ''`;
        case 'is_unknown':
          return `JSON_EXTRACT_STRING(ce.properties, '${k}') IS NULL OR JSON_EXTRACT_STRING(ce.properties, '${k}') = ''`;
        case 'greater_than': {
          const num = assertFiniteNumber(value, 'propertyFilter.value');
          return `toFloat64OrNull(JSON_EXTRACT_STRING(ce.properties, '${k}')) > ${num}`;
        }
        case 'less_than': {
          const num = assertFiniteNumber(value, 'propertyFilter.value');
          return `toFloat64OrNull(JSON_EXTRACT_STRING(ce.properties, '${k}')) < ${num}`;
        }
        default:
          throw new Error(`Unsupported property filter operator: ${operator}`);
      }
    });

    return conditions.join(' AND ');
  }
}
