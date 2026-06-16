import {
  AssignToPipelineNode,
  AssignToPipelineNodeInput,
} from './assign-to-pipeline.node';

describe('AssignToPipelineNode', () => {
  let node: AssignToPipelineNode;
  let addToPipeline: jest.Mock;

  const baseInput: AssignToPipelineNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { pipeline_id: 'p1', pipeline_stage_id: 'st1' },
  };

  beforeEach(() => {
    node = new AssignToPipelineNode();
    addToPipeline = jest.fn();
    (node as any).crmService = { addToPipeline };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
  });

  it('adds the conversation to the pipeline stage (happy path)', async () => {
    addToPipeline.mockResolvedValue({ success: true, data: { id: 'item-1' } });

    const result = await node.execute(baseInput);

    expect(addToPipeline).toHaveBeenCalledWith(
      'p1',
      'conv-1',
      'st1',
      'assign-to-pipeline',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      node_n1_pipeline_assigned: true,
      node_n1_pipeline_id: 'p1',
    });
  });

  it('skips when pipeline_id is missing', async () => {
    const result = await node.execute({ ...baseInput, nodeData: {} });

    expect(addToPipeline).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_pipeline_id');
  });
});
