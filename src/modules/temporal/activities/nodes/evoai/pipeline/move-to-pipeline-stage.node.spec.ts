import {
  MoveToPipelineStageNode,
  MoveToPipelineStageNodeInput,
} from './move-to-pipeline-stage.node';

describe('MoveToPipelineStageNode', () => {
  let node: MoveToPipelineStageNode;
  let moveToPipelineStage: jest.Mock;

  const baseInput: MoveToPipelineStageNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { pipeline_id: 'p1', pipeline_stage_id: 'st1' },
  };

  beforeEach(() => {
    node = new MoveToPipelineStageNode();
    moveToPipelineStage = jest.fn();
    (node as any).crmService = { moveToPipelineStage };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
  });

  // The mocks below mirror the real CRM `success_response` envelope:
  // executeRequest stores the whole body under `data`, so the move result is
  // nested at `data.data` — the node must unwrap that level (regression guard).
  it('moves the conversation to the target pipeline stage (happy path)', async () => {
    moveToPipelineStage.mockResolvedValue({
      success: true,
      data: { success: true, data: { moved: true, movement_type: 'cross_pipeline' } },
    });

    const result = await node.execute(baseInput);

    expect(moveToPipelineStage).toHaveBeenCalledWith(
      'p1',
      'conv-1',
      'st1',
      'move-to-pipeline-stage',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      node_n1_pipeline_moved: true,
      node_n1_pipeline_id: 'p1',
      node_n1_stage_id: 'st1',
    });
  });

  it('skips when stage_id is missing', async () => {
    const result = await node.execute({
      ...baseInput,
      nodeData: { pipeline_id: 'p1' },
    });

    expect(moveToPipelineStage).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_stage_id');
  });

  it('skips when pipeline_id is missing', async () => {
    const result = await node.execute({
      ...baseInput,
      nodeData: { pipeline_stage_id: 'st1' },
    });

    expect(moveToPipelineStage).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_pipeline_id');
  });

  it('surfaces a CRM skip for a deleted target stage as skipped (AC3)', async () => {
    moveToPipelineStage.mockResolvedValue({
      success: true,
      data: { success: true, data: { moved: false, skipped: true, reason: 'stage_not_found' } },
    });

    const result = await node.execute(baseInput);

    expect(moveToPipelineStage).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('stage_not_found');
  });

  it('returns an error result when the CRM call fails', async () => {
    moveToPipelineStage.mockResolvedValue({ success: false, error: 'boom' });

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
  });
});
