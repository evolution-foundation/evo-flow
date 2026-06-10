import { SendMessageNode, SendMessageNodeInput } from './send-message.node';

describe('SendMessageNode', () => {
  let node: SendMessageNode;
  let sendMessage: jest.Mock;
  let getInboxMessageTemplates: jest.Mock;

  const textInput: SendMessageNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: { message: 'Hello free text' },
  };

  const templateInput: SendMessageNodeInput = {
    nodeId: 'n1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: {
      messageMode: 'template',
      inboxId: 'inbox-1',
      templateId: 'tpl-1',
      templateName: 'welcome',
      templateLanguage: 'pt_BR',
      templateParams: { first_name: 'Ana' },
    },
  };

  const template = {
    id: 'tpl-1',
    name: 'welcome',
    content: 'Olá {{first_name}}, bem-vinda ao {{company}}!',
    language: 'pt_BR',
    category: 'UTILITY',
    variables: [
      { name: 'first_name', default_value: '' },
      { name: 'company', default_value: 'Evo' },
    ],
  };

  beforeEach(() => {
    node = new SendMessageNode();
    sendMessage = jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'msg-1' } });
    getInboxMessageTemplates = jest.fn();
    (node as any).crmService = { sendMessage, getInboxMessageTemplates };
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation((_input, nodeData) => Promise.resolve(nodeData));
  });

  describe('text mode (legacy regression)', () => {
    it('sends the free-form message without template_params', async () => {
      const result = await node.execute(textInput);

      expect(sendMessage).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        'Hello free text',
        false,
        'send-message',
        undefined,
      );
      expect(getInboxMessageTemplates).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({ node_n1_message_sent: true });
    });

    it('falls back to the default message when nothing is configured', async () => {
      await node.execute({ ...textInput, nodeData: {} });

      expect(sendMessage).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        'Olá! Esta é uma mensagem automática da sua jornada.',
        false,
        'send-message',
        undefined,
      );
    });

    it('skips when there is no conversationId from the trigger event', async () => {
      const result = await node.execute({
        ...textInput,
        conversationId: undefined,
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({ node_n1_message_sent: false });
    });
  });

  describe('template mode (EVO-1255)', () => {
    it('AC4: resolves the template, renders vars and sends content + template_params', async () => {
      getInboxMessageTemplates.mockResolvedValue({
        success: true,
        data: { success: true, data: [template] },
      });

      const result = await node.execute(templateInput);

      expect(getInboxMessageTemplates).toHaveBeenCalledWith('inbox-1');
      expect(sendMessage).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        'Olá Ana, bem-vinda ao Evo!',
        false,
        'send-message',
        {
          name: 'welcome',
          language: 'pt_BR',
          category: 'UTILITY',
          processed_params: { first_name: 'Ana' },
        },
      );
      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({
        node_n1_message_sent: true,
        node_n1_template_id: 'tpl-1',
      });
    });

    it('uses variable default_value when no param is provided and keeps unknown placeholders', async () => {
      getInboxMessageTemplates.mockResolvedValue({
        success: true,
        data: {
          success: true,
          data: [{ ...template, content: '{{company}} / {{missing}}' }],
        },
      });

      await node.execute({
        ...templateInput,
        nodeData: { ...templateInput.nodeData, templateParams: {} },
      });

      expect(sendMessage.mock.calls[0][1]).toBe('Evo / {{missing}}');
    });

    it('skips (no send) when the template was deleted or deactivated', async () => {
      getInboxMessageTemplates.mockResolvedValue({
        success: true,
        data: { success: true, data: [] },
      });

      const result = await node.execute(templateInput);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({ node_n1_message_sent: false });
    });

    it('skips when the templates fetch fails (CRM unavailable)', async () => {
      getInboxMessageTemplates.mockResolvedValue({
        success: false,
        error: 'down',
      });

      const result = await node.execute(templateInput);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({ node_n1_message_sent: false });
    });

    it('skips when template mode has no templateId configured', async () => {
      const result = await node.execute({
        ...templateInput,
        nodeData: { messageMode: 'template', inboxId: 'inbox-1' },
      });

      expect(getInboxMessageTemplates).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });
});
