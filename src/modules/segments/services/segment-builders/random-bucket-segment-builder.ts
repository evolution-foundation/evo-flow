import { Injectable } from '@nestjs/common';
import { BaseSegmentBuilder } from './base-segment-builder';
import {
  SegmentNode,
  SegmentQueryResult,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';

@Injectable()
export class RandomBucketSegmentBuilder extends BaseSegmentBuilder {
  async buildQuery(node: SegmentNode): Promise<SegmentQueryResult> {
    this.validateNode(node, ['type', 'percentage']);

    const percentage = (node as any).percentage || 50; // Default to 50%

    // Use contact_id hash to ensure deterministic random distribution
    const query = `
      SELECT DISTINCT ce.contact_id
      FROM evo_campaign.contact_events ce
      WHERE (cityHash64(ce.contact_id) % 100) < ${percentage}
        AND ${ContactExclusionQueries.getDeletedContactExclusion('ce.contact_id')}
      GROUP BY ce.contact_id
      HAVING ${ContactExclusionQueries.getLatestContactStateExclusion()}
    `;

    this.logQuery(query, `RandomBucket-${percentage}%`);
    const contactIds = await this.executeQuery(query);

    return { query, contactIds };
  }
}
