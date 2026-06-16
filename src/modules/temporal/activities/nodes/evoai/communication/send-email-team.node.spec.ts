import {
  SendEmailTeamNode,
  SendEmailTeamNodeInput,
} from './send-email-team.node';

describe('SendEmailTeamNode', () => {
  let node: SendEmailTeamNode;
  let sendEmailTeam: jest.Mock;

  const baseInput: SendEmailTeamNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { team_ids: ['t1', 't2'], message: 'Hi team' },
  };

  beforeEach(() => {
    node = new SendEmailTeamNode();
    sendEmailTeam = jest.fn();
    (node as any).crmService = { sendEmailTeam };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
  });

  it('sends the team email with the configured teams and message (happy path)', async () => {
    sendEmailTeam.mockResolvedValue({ success: true, data: {} });

    const result = await node.execute(baseInput);

    expect(sendEmailTeam).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      ['t1', 't2'],
      'Hi team',
      'send-email-team',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({ node_n1_team_emailed: true });
  });

  it('skips when team_ids or message is missing', async () => {
    const result = await node.execute({
      ...baseInput,
      nodeData: { message: 'x' },
    });

    expect(sendEmailTeam).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('missing_team_ids_or_message');
  });
});
