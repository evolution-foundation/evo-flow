import { SegmentsController } from './segments.controller';
import { AdvancedSegmentDefinition } from './entities/segment.entity';

describe('SegmentsController.preview', () => {
  const definition: AdvancedSegmentDefinition = {
    entryNode: { id: 'entry', type: 'Everyone' },
    nodes: [],
  };

  const build = () => {
    const segmentsService: any = {
      previewByDefinition: jest
        .fn()
        .mockResolvedValue({ count: 5, sample: [{ id: 'c1' }] }),
    };
    const cls: any = { get: jest.fn() };
    const segmentModeManager: any = {};
    const controller = new SegmentsController(segmentsService, cls, segmentModeManager);
    return { controller, segmentsService };
  };

  it('forwards the inline definition and returns the preview body', async () => {
    const { controller, segmentsService } = build();
    const result = await controller.preview({ definition });
    expect(segmentsService.previewByDefinition).toHaveBeenCalledWith(definition);
    expect(result).toEqual({ count: 5, sample: [{ id: 'c1' }] });
  });
});
