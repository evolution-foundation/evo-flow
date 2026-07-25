// Silence @temporalio/activity log calls under unit-test (no activity context).
jest.mock('@temporalio/activity', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

process.env.EVOAI_CRM_BASE_URL = 'http://crm-test.local';
process.env.EVOAI_CRM_API_TOKEN = 'svc-token';

import {
  AssignToPipelineNode,
  AssignToPipelineNodeInput,
} from './assign-to-pipeline.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

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

  // EVO-2203: the examples above mock the CRM client away, so nothing here proved
  // what a real refusal looks like on the run. This one drives the real client
  // against the CRM's archived-pipeline answer: the journey must stop with the
  // reason, never continue as success.
  describe('with the real CRM client (archived pipeline)', () => {
    it('fails visibly carrying the CRM refusal reason', async () => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'HTTP 422',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              success: false,
              error: {
                code: 'PIPELINE_ARCHIVED',
                message:
                  'Pipeline is archived and cannot receive conversations',
              },
            }),
          ),
      });
      (node as any).crmService = new CrmClientService();

      const result = await node.execute(baseInput);

      expect(result.success).toBe(false);
      expect(result.error).toContain('PIPELINE_ARCHIVED');
      expect(result.error).toContain(
        'Pipeline is archived and cannot receive conversations',
      );
      expect(result.error).not.toContain('{');
    });
  });
});
