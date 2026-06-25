// AssignBotNode instantiates CrmClientService in its constructor, which
// requires these env vars. Set them before import so the suite runs (and so the
// EVO-1919 verification tests below are exercised rather than blocked at ctor).
process.env.EVOAI_CRM_API_TOKEN ||= 'test-token';
process.env.EVOAI_CRM_BASE_URL ||= 'http://crm-test.local';

import { AssignBotNode } from './assign-bot.node';

describe('AssignBotNode', () => {
  // Build a node with a stubbed crmService. `boundBot` is what getInboxBot
  // returns inside the `{ data: { data: ... } }` CRM envelope (null = no bind).
  const makeNode = (opts: {
    assignBot?: jest.Mock;
    boundBot?: any;
    verifyEnabled?: boolean;
    getInboxBot?: jest.Mock;
  }) => {
    const node = new AssignBotNode();
    const assignBot =
      opts.assignBot ?? jest.fn().mockResolvedValue({ success: true, data: {} });
    const getInboxBot =
      opts.getInboxBot ??
      jest
        .fn()
        .mockResolvedValue({ success: true, data: { data: opts.boundBot } });
    (node as any).crmService = {
      assignBot,
      getInboxBot,
      isEffectVerificationEnabled: jest
        .fn()
        .mockReturnValue(opts.verifyEnabled ?? true),
    };
    // Reuse the real verifyEffect implementation from CrmClientService so the
    // node's verification wiring is exercised end-to-end.
    const {
      CrmClientService,
    } = require('../../../../../../shared/crm-client/crm-client.service');
    (node as any).crmService.verifyEffect =
      CrmClientService.prototype.verifyEffect.bind((node as any).crmService);

    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation((_input: any, nodeData: any) =>
        Promise.resolve(nodeData),
      );
    // logNodeStart/Success/Error call @temporalio/activity log which requires
    // an activity context; stub them out for unit tests.
    jest
      .spyOn(node as any, 'logNodeStart')
      .mockImplementation(() => undefined);
    jest
      .spyOn(node as any, 'logNodeSuccess')
      .mockImplementation(() => undefined);
    jest
      .spyOn(node as any, 'logNodeError')
      .mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);
    return { node, assignBot, getInboxBot };
  };

  afterEach(() => jest.restoreAllMocks());

  // EVO-1741 regression guard: assign-bot is inbox-level (set_agent_bot) and
  // does NOT use conversationId, so it must NOT be treated as conversation-
  // required — it runs on a contact-only trigger as long as inbox_id is set.
  it('runs without a conversation (inbox-level) and is not falsely skipped', async () => {
    const { node, assignBot } = makeNode({ boundBot: { id: 'b1' } });

    const result = await node.execute({
      nodeId: 'n1',
      conversationId: '',
      sessionId: 's1',
      nodeData: { inbox_id: 'inbox-1', bot_id: 'b1' },
    });

    expect(assignBot).toHaveBeenCalledWith('inbox-1', 'b1');
    expect(result.success).toBe(true);
    expect(result.skipped).toBeFalsy();
  });

  it('EVO-1919: fails when CRM returns 2xx but the bot binding was not created (D11)', async () => {
    // assignBot 200, but re-read shows no bound bot.
    const { node, getInboxBot } = makeNode({ boundBot: null });

    const result = await node.execute({
      nodeId: 'n1',
      conversationId: '',
      sessionId: 's1',
      nodeData: { inbox_id: 'inbox-1', bot_id: 'b1' },
    });

    expect(getInboxBot).toHaveBeenCalledWith('inbox-1');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not persisted/i);
  });

  it('EVO-1919: unassignment is confirmed when re-read shows no bound bot', async () => {
    const { node } = makeNode({ boundBot: null });

    const result = await node.execute({
      nodeId: 'n1',
      conversationId: '',
      sessionId: 's1',
      nodeData: { inbox_id: 'inbox-1' }, // no bot_id → unassign
    });

    expect(result.success).toBe(true);
  });

  it('EVO-1919: a flaky verification probe does NOT fail the node', async () => {
    const getInboxBot = jest
      .fn()
      .mockRejectedValue(new Error('CRM unavailable'));
    const { node } = makeNode({ getInboxBot });

    const result = await node.execute({
      nodeId: 'n1',
      conversationId: '',
      sessionId: 's1',
      nodeData: { inbox_id: 'inbox-1', bot_id: 'b1' },
    });

    expect(result.success).toBe(true);
  });

  it('EVO-1919: skips verification entirely when the flag is disabled', async () => {
    const { node, getInboxBot } = makeNode({
      verifyEnabled: false,
      boundBot: null,
    });

    const result = await node.execute({
      nodeId: 'n1',
      conversationId: '',
      sessionId: 's1',
      nodeData: { inbox_id: 'inbox-1', bot_id: 'b1' },
    });

    expect(getInboxBot).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
