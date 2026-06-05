import {
  DeferConversationNode,
  DeferConversationNodeInput,
} from './defer-conversation.node';

describe('DeferConversationNode', () => {
  let node: DeferConversationNode;
  let changeConversationStatus: jest.Mock;

  const baseInput: DeferConversationNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: {},
  };

  beforeEach(() => {
    node = new DeferConversationNode();
    changeConversationStatus = jest.fn();
    (node as any).crmService = { changeConversationStatus };
  });

  it('moves the conversation to the snoozed status (defer is the snooze effect)', async () => {
    changeConversationStatus.mockResolvedValue({
      success: true,
      data: { id: 'x' },
    });

    const result = await node.execute(baseInput);

    expect(changeConversationStatus).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      'snoozed',
      'defer-conversation',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      node_n1_conversation_deferred: true,
      node_n1_status: 'snoozed',
    });
  });

  it('returns an error result when the CRM call fails', async () => {
    changeConversationStatus.mockResolvedValue({
      success: false,
      error: 'boom',
    });

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
  });
});
