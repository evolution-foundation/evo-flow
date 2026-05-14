import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';

@Injectable()
export class EveryoneSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type']);

    // Query baseada exatamente no backup funcional
    const query = `
      SELECT DISTINCT contact_id
      FROM evo_campaign.contact_events
      WHERE contact_id NOT IN (
        SELECT DISTINCT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'contact_deleted'
        GROUP BY contact_id
        HAVING argMax(occurred_at, occurred_at) > 0
      )
    `;

    this.logQuery(query, 'Everyone');
    const contactIds = await this.executeQuery(query);

    return {
      query,
      contactIds,
    };
  }
}
