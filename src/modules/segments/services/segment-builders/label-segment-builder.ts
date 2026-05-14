import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class LabelSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'value']);

    if (node.type === 'has_label') {
      return this.buildHasLabelQuery(node);
    } else if (node.type === 'not_has_label') {
      return this.buildNotHasLabelQuery(node);
    }

    throw new Error(`Unsupported label node type: ${node.type}`);
  }

  private async buildHasLabelQuery(
    node: SegmentNode,
  ): Promise<SegmentQueryResult> {
    const labelName = node.value;

    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.event_name = 'label_added'
        AND JSON_EXTRACT_STRING(ce.properties, 'labelName') = '${labelName}'
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'HasLabel');
    const contactIds = await this.executeQuery(query);

    return {
      query,
      contactIds,
    };
  }

  private async buildNotHasLabelQuery(
    node: SegmentNode,
  ): Promise<SegmentQueryResult> {
    const labelName = node.value;

    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ce.contact_id NOT IN (
          SELECT DISTINCT ce2.contact_id
          FROM evo_campaign.contact_events ce2
          WHERE ce2.event_name = 'label_added'
            AND JSON_EXTRACT_STRING(ce2.properties, 'labelName') = '${labelName}'
        )
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, 'NotHasLabel');
    const contactIds = await this.executeQuery(query);

    return {
      query,
      contactIds,
    };
  }
}
