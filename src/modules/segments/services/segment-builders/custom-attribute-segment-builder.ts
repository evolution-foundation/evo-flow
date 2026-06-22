import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class CustomAttributeSegmentBuilder extends BaseSegmentBuilder {
  // The custom-attribute change is an identify-DTO event. The CRM stores the
  // canonical dotted name (older producers used the short underscore form) and
  // the payload in the `traits` column as { attributeName, attributeValue,
  // changeType } — one row per change (EVO-1839). Earlier this builder filtered
  // `event_name = 'identify'` and read `traits['<attrName>']` (a never-emitted
  // named-key shape); both were wrong. Accept both event-name forms and read the
  // canonical fields below.
  private static readonly EVENT_FILTER =
    "ce.event_name IN ('contact.custom_attribute.changed', 'custom_attribute_changed')";

  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'operator', 'value']);

    const { operator, value } = node;
    const attributeName = node.key || node.attribute_name;

    if (!attributeName) {
      throw new Error('Custom attribute node must have key or attribute_name');
    }

    switch (operator) {
      case 'equals':
        return this.buildComparisonQuery(
          attributeName,
          `= '${value}'`,
          'Equals',
        );
      case 'not_equals':
        // include contacts whose latest value differs OR who cleared the attribute
        return this.buildComparisonQuery(
          attributeName,
          `!= '${value}'`,
          'NotEquals',
        );
      case 'contains':
        return this.buildComparisonQuery(
          attributeName,
          `LIKE '%${value}%'`,
          'Contains',
        );
      case 'not_contains':
        return this.buildComparisonQuery(
          attributeName,
          `NOT LIKE '%${value}%'`,
          'NotContains',
        );
      case 'is_known':
        return this.buildComparisonQuery(attributeName, `!= ''`, 'IsKnown');
      case 'is_unknown':
        return this.buildComparisonQuery(attributeName, `= ''`, 'IsUnknown');
      default:
        throw new Error(`Unsupported custom attribute operator: ${operator}`);
    }
  }

  /**
   * The *current* value of an attribute is the latest change's `attributeValue`
   * via argMax(occurred_at); a `removed` change clears it to ''. The predicate
   * (e.g. `= 'gold'`, `!= ''`) is applied to that current value in HAVING, so a
   * contact matches on their newest state rather than any historical row.
   *
   * Note: a contact with no change event for this attribute does not appear here
   * (no row to group) — same as the previous GROUP BY behaviour.
   */
  private async buildComparisonQuery(
    attributeName: string,
    valuePredicate: string,
    label: string,
  ): Promise<SegmentQueryResult> {
    const currentValue = `argMax(
        CASE
          WHEN JSON_EXTRACT_STRING(ce.traits, 'changeType') = 'removed' THEN ''
          ELSE JSON_EXTRACT_STRING(ce.traits, 'attributeValue')
        END,
        ce.occurred_at
      )`;

    const query = `
      SELECT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ${CustomAttributeSegmentBuilder.EVENT_FILTER}
        AND JSON_EXTRACT_STRING(ce.traits, 'attributeName') = '${attributeName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
        AND ${currentValue} ${valuePredicate}
    `;

    this.logQuery(query, `CustomAttribute-${label}`);
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }
}
