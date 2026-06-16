import { AssignBotNode } from './assign-bot.node';

describe('AssignBotNode', () => {
  // EVO-1741 regression guard: assign-bot is inbox-level (set_agent_bot) and
  // does NOT use conversationId, so it must NOT be treated as conversation-
  // required — it runs on a contact-only trigger as long as inbox_id is set.
  it('runs without a conversation (inbox-level) and is not falsely skipped', async () => {
    const node = new AssignBotNode();
    const assignBot = jest.fn().mockResolvedValue({ success: true, data: {} });
    (node as any).crmService = { assignBot };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation((_input, nodeData) => Promise.resolve(nodeData));

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
});
