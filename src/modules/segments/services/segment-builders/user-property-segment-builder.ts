import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class UserPropertySegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'operator', 'value']);

    const { operator, value } = node;
    const propertyName = node.key || node.property_name;

    if (!propertyName) {
      throw new Error('User property node must have key or property_name');
    }

    switch (operator) {
      case 'equals':
        return this.buildEqualsQuery(propertyName, value);
      case 'not_equals':
        return this.buildNotEqualsQuery(propertyName, value);
      case 'contains':
        return this.buildContainsQuery(propertyName, value);
      case 'not_contains':
        return this.buildNotContainsQuery(propertyName, value);
      case 'is_known':
        return this.buildIsKnownQuery(propertyName);
      case 'is_unknown':
        return this.buildIsUnknownQuery(propertyName);
      default:
        throw new Error(`Unsupported user property operator: ${operator}`);
    }
  }

  private async buildEqualsQuery(
    propertyName: string,
    value: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${propertyName}') = '${value}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-Equals');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildNotEqualsQuery(
    propertyName: string,
    value: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${propertyName}') != '${value}'
          OR JSON_EXTRACT_STRING(ce.traits, '${propertyName}') IS NULL
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-NotEquals');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildContainsQuery(
    propertyName: string,
    value: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${propertyName}') LIKE '%${value}%'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-Contains');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildNotContainsQuery(
    propertyName: string,
    value: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${propertyName}') NOT LIKE '%${value}%'
          OR JSON_EXTRACT_STRING(ce.traits, '${propertyName}') IS NULL
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-NotContains');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildIsKnownQuery(
    propertyName: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${propertyName}') IS NOT NULL
        AND JSON_EXTRACT_STRING(ce.traits, '${propertyName}') != ''
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-IsKnown');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildIsUnknownQuery(
    propertyName: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${propertyName}') IS NULL
          OR JSON_EXTRACT_STRING(ce.traits, '${propertyName}') = ''
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'UserProperty-IsUnknown');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }
}
