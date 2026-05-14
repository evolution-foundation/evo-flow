import { SegmentQueryBuilderService } from './segment-query-builder.service';

describe('SegmentQueryBuilderService', () => {
  const segmentRepository: any = {};
  const taggingRepository: any = {};
  const contactsClient: any = {};
  const service = new SegmentQueryBuilderService(
    segmentRepository,
    taggingRepository,
    contactsClient,
  );

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

