import { SegmentQueryBuilderService } from './segment-query-builder.service';
import { Segment } from '../../modules/segments/entities/segment.entity';
import { TenantDbContext } from '../../evo-extension-points';

describe('SegmentQueryBuilderService', () => {
  const segmentRepository: any = {};
  const taggingRepository: any = {};
  const db = {
    getRepository: (entity: unknown) =>
      entity === Segment ? segmentRepository : taggingRepository,
  } as unknown as TenantDbContext;
  const contactsClient: any = {};
  const service = new SegmentQueryBuilderService(db, contactsClient);

  it('uses triggerConfig.segment_id as segment strategy', async () => {
    const campaign: any = {
      sendToAll: false,
      triggerConfig: { segment_id: 'seg-trigger-1' },
      steps: null,
      tags: [],
      query: null,
    };

    const result = await service.analyzeSegmentationStrategy(campaign);

    expect(result).toEqual({
      type: 'segment',
      segmentId: 'seg-trigger-1',
    });
  });

  it('extracts segment id recursively from nested steps', async () => {
    const campaign: any = {
      sendToAll: false,
      triggerConfig: null,
      steps: {
        nodes: [
          { id: 'start' },
          {
            id: 'filter',
            config: {
              conditions: [
                { op: 'eq', value: 1 },
                { nested: { segmentId: 'seg-nested-42' } },
              ],
            },
          },
        ],
      },
      tags: [],
      query: null,
    };

    const result = await service.analyzeSegmentationStrategy(campaign);

    expect(result).toEqual({
      type: 'segment',
      segmentId: 'seg-nested-42',
    });
  });
});
