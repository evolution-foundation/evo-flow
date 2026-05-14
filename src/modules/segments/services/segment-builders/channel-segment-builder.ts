import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class ChannelSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type']);

    const { type } = node;
    let channelCondition = '';

    switch (type) {
      case 'WhatsApp':
        channelCondition =
          "JSON_EXTRACT_STRING(ce.properties, 'channel') = 'whatsapp'";
        break;
      case 'Web':
        channelCondition =
          "JSON_EXTRACT_STRING(ce.properties, 'channel') = 'web'";
        break;
      case 'SMS':
        channelCondition =
          "JSON_EXTRACT_STRING(ce.properties, 'channel') = 'sms'";
        break;
      default:
        throw new Error(`Unsupported channel type: ${type}`);
    }

    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE ${channelCondition}
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, `Channel-${type}`);
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }
}
