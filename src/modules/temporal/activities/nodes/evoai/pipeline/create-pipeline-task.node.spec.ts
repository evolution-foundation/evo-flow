import {
  CreatePipelineTaskNode,
  CreatePipelineTaskNodeInput,
} from './create-pipeline-task.node';

describe('CreatePipelineTaskNode', () => {
  let node: CreatePipelineTaskNode;
  let createPipelineTask: jest.Mock;

  const baseInput: CreatePipelineTaskNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { title: 'Follow up', priority: 'high', task_type: 'call' },
  };

  beforeEach(() => {
    node = new CreatePipelineTaskNode();
    createPipelineTask = jest.fn();
    (node as any).crmService = { createPipelineTask };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
  });

  // The CRM result is nested one level under the success_response envelope
  // (`data.data`) — the node must unwrap it (regression guard from EVO-1272).
  it('creates the task and maps a relative due date to "<value>.<unit>"', async () => {
    createPipelineTask.mockResolvedValue({
      success: true,
      data: { success: true, data: { created: true, task_id: 'task-9' } },
    });

    const result = await node.execute({
      ...baseInput,
      nodeData: {
        ...baseInput.nodeData,
        due_date: { value: 2, unit: 'hours' },
      },
    });

    expect(createPipelineTask).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        title: 'Follow up',
        priority: 'high',
        task_type: 'call',
        due_in: '2.hours',
      }),
      'create-pipeline-task',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      node_n1_task_created: true,
      node_n1_task_id: 'task-9',
    });
  });

  it('omits due_in when no due date is configured', async () => {
    createPipelineTask.mockResolvedValue({
      success: true,
      data: { success: true, data: { created: true, task_id: 't1' } },
    });

    await node.execute(baseInput);

    expect(createPipelineTask.mock.calls[0][1].due_in).toBeUndefined();
  });

  it('skips when the title is missing', async () => {
    const result = await node.execute({
      ...baseInput,
      nodeData: { priority: 'low' },
    });

    expect(createPipelineTask).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_title');
  });

  it('skips when no conversationId is available', async () => {
    const result = await node.execute({
      ...baseInput,
      conversationId: undefined,
    });

    expect(createPipelineTask).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_conversation_id');
  });

  it('surfaces a CRM skip (no active pipeline_item) as skipped (AC3)', async () => {
    createPipelineTask.mockResolvedValue({
      success: true,
      data: {
        success: true,
        data: { created: false, skipped: true, reason: 'no_pipeline_item' },
      },
    });

    const result = await node.execute(baseInput);

    expect(createPipelineTask).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('no_pipeline_item');
  });

  it('returns an error result when the CRM call fails', async () => {
    createPipelineTask.mockResolvedValue({ success: false, error: 'boom' });

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
  });
});
