import { SegmentsService } from './segments.service';
import { AdvancedSegmentDefinition } from './entities/segment.entity';

describe('SegmentsService.previewByDefinition', () => {
  const everyoneDefinition: AdvancedSegmentDefinition = {
    entryNode: { id: 'entry', type: 'Everyone' },
    nodes: [],
  };

  const build = () => {
    const segmentRepository: any = {
      create: jest.fn((partial) => ({ ...partial })),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    const segmentComputationService: any = {
      getSegmentContacts: jest.fn().mockResolvedValue(['c1', 'c2', 'c3']),
    };
    const modularSegmentComputationService: any = {
      computeState: jest.fn().mockResolvedValue(undefined),
      computeAssignments: jest.fn().mockResolvedValue(undefined),
      countFinalAssignments: jest.fn().mockResolvedValue({
        contactsAdded: 0,
        contactsRemoved: 0,
        totalContacts: 42,
      }),
      cleanupOldSegmentData: jest.fn().mockResolvedValue(undefined),
    };
    const segmentCacheService: any = {};
    const eventEmitter: any = { emit: jest.fn() };

    const service = new SegmentsService(
      segmentRepository,
      segmentComputationService,
      modularSegmentComputationService,
      segmentCacheService,
      eventEmitter,
    );

    return { service, segmentRepository, segmentComputationService, modularSegmentComputationService };
  };

  it('returns the in-segment count and a sample of contact ids', async () => {
    const { service } = build();
    const result = await service.previewByDefinition(everyoneDefinition);
    expect(result).toEqual({
      count: 42,
      sample: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    });
  });

  it('runs STAGE 1 + STAGE 2 against a transient preview-* segment and never persists it', async () => {
    const { service, segmentRepository, modularSegmentComputationService } = build();

    await service.previewByDefinition(everyoneDefinition);

    expect(segmentRepository.create).toHaveBeenCalledTimes(1);
    expect(segmentRepository.save).not.toHaveBeenCalled();
    const built = segmentRepository.create.mock.calls[0][0];
    expect(built.id).toMatch(/^preview-/);
    expect(built.definition).toBe(everyoneDefinition);
    expect(modularSegmentComputationService.computeState).toHaveBeenCalledTimes(1);
    expect(modularSegmentComputationService.computeAssignments).toHaveBeenCalledTimes(1);
  });

  it('always cleans up the ephemeral ClickHouse rows by preview id', async () => {
    const { service, modularSegmentComputationService } = build();
    await service.previewByDefinition(everyoneDefinition);
    const previewId = modularSegmentComputationService.countFinalAssignments.mock.calls[0][0];
    expect(previewId).toMatch(/^preview-/);
    expect(modularSegmentComputationService.cleanupOldSegmentData).toHaveBeenCalledWith(previewId);
  });

  it('rejects a definition without entryNode (422) before touching ClickHouse', async () => {
    const { service, modularSegmentComputationService } = build();
    await expect(service.previewByDefinition({} as never)).rejects.toThrow(/entryNode/);
    expect(modularSegmentComputationService.computeState).not.toHaveBeenCalled();
  });

  it('still cleans up when computation throws', async () => {
    const { service, modularSegmentComputationService } = build();
    modularSegmentComputationService.computeAssignments.mockRejectedValueOnce(
      new Error('clickhouse down'),
    );
    await expect(service.previewByDefinition(everyoneDefinition)).rejects.toThrow('clickhouse down');
    expect(modularSegmentComputationService.cleanupOldSegmentData).toHaveBeenCalledTimes(1);
  });
});
