import {
  SendCannedResponseNode,
  SendCannedResponseNodeInput,
} from './send-canned-response.node';

describe('SendCannedResponseNode', () => {
  let node: SendCannedResponseNode;
  let getCannedResponse: jest.Mock;
  let sendMessage: jest.Mock;

  const baseInput: SendCannedResponseNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { canned_response_id: 'cr-1' },
  };

  beforeEach(() => {
    node = new SendCannedResponseNode();
    getCannedResponse = jest.fn();
    sendMessage = jest.fn();
    (node as any).crmService = { getCannedResponse, sendMessage };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
  });

  it('resolves canned content by id and sends it as a message (happy path)', async () => {
    getCannedResponse.mockResolvedValue({
      success: true,
      data: { data: { id: 'cr-1', content: 'Hello there' } },
    });
    sendMessage.mockResolvedValue({ success: true, data: { id: 'msg-1' } });

    const result = await node.execute(baseInput);

    expect(getCannedResponse).toHaveBeenCalledWith('cr-1');
    expect(sendMessage).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      'Hello there',
      false,
      'send-canned-response',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      node_n1_message_sent: true,
      node_n1_canned_response_id: 'cr-1',
    });
  });

  it('skips the send (no message) when the canned response is not found', async () => {
    getCannedResponse.mockResolvedValue({ success: false, error: 'not found' });

    const result = await node.execute(baseInput);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({ node_n1_message_sent: false });
  });

  it('skips when no canned_response_id is configured', async () => {
    const result = await node.execute({ ...baseInput, nodeData: {} });

    expect(getCannedResponse).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
