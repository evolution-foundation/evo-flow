import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class CustomAttributeSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'operator', 'value']);

    const { operator, value } = node;
    const attributeName = node.key || node.attribute_name;

    if (!attributeName) {
      throw new Error('Custom attribute node must have key or attribute_name');
    }

    switch (operator) {
      case 'equals':
        return this.buildEqualsQuery(attributeName, value);
      case 'not_equals':
        return this.buildNotEqualsQuery(attributeName, value);
      case 'contains':
        return this.buildContainsQuery(attributeName, value);
      case 'not_contains':
        return this.buildNotContainsQuery(attributeName, value);
      case 'is_known':
        return this.buildIsKnownQuery(attributeName);
      case 'is_unknown':
        return this.buildIsUnknownQuery(attributeName);
      default:
        throw new Error(`Unsupported custom attribute operator: ${operator}`);
    }
  }

  private async buildEqualsQuery(
    attributeName: string,
    value: any,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${attributeName}') = '${value}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-Equals');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildNotEqualsQuery(
    attributeName: string,
    value: any,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${attributeName}') != '${value}'
          OR JSON_EXTRACT_STRING(ce.traits, '${attributeName}') IS NULL
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-NotEquals');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildContainsQuery(
    attributeName: string,
    value: any,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${attributeName}') LIKE '%${value}%'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-Contains');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildNotContainsQuery(
    attributeName: string,
    value: any,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${attributeName}') NOT LIKE '%${value}%'
          OR JSON_EXTRACT_STRING(ce.traits, '${attributeName}') IS NULL
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-NotContains');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildIsKnownQuery(
    attributeName: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND JSON_EXTRACT_STRING(ce.traits, '${attributeName}') IS NOT NULL
        AND JSON_EXTRACT_STRING(ce.traits, '${attributeName}') != ''
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-IsKnown');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }

  private async buildIsUnknownQuery(
    attributeName: string,
  ): Promise<SegmentQueryResult> {
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'identify'
        AND (
          JSON_EXTRACT_STRING(ce.traits, '${attributeName}') IS NULL
          OR JSON_EXTRACT_STRING(ce.traits, '${attributeName}') = ''
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'CustomAttribute-IsUnknown');
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }
}
