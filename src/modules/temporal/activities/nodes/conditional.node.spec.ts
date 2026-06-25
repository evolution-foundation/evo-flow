import { ConditionalNode, ConditionalNodeInput } from './conditional.node';

// logNodeError() calls @temporalio/activity's `log`, which throws outside an
// activity context. Stub it so the node's error path (exercised by EVO-1913)
// runs without a live Temporal worker.
jest.mock('@temporalio/activity', () => ({
  log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockGetConversation = jest.fn();
jest.mock('../../../../shared/crm-client/crm-client.service', () => ({
  CrmClientService: jest.fn().mockImplementation(() => ({
    getConversation: mockGetConversation,
  })),
}));

describe('ConditionalNode — {{conversation.pipeline_stage_id}}', () => {
  let node: ConditionalNode;

  const STAGE_X = 'stage-x-uuid';
  const STAGE_Y = 'stage-y-uuid';

  const inputWith = (
    operator: 'equals' | 'not_equals',
    value: string,
  ): ConditionalNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    conversationId: 'conv-1',
    sessionId: 's1',
    nodeData: {
      paths: [
        {
          id: 'p1',
          name: 'Stage path',
          conditions: [
            {
              id: 'cond-1',
              // `custom` on purpose: conversation fields are resolved by field
              // pattern, independent of the condition type.
              type: 'custom',
              field: '{{conversation.pipeline_stage_id}}',
              operator,
              value,
            },
          ],
          logicalOperator: 'AND',
        },
      ],
    },
  });

  const conversationInStages = (...stageIds: string[]) => ({
    pipelines: stageIds.map((id, i) => ({
      id: `pl-${i}`,
      name: `Pipeline ${i}`,
      stages: [{ id, name: id }],
    })),
  });

  beforeEach(() => {
    node = new ConditionalNode();

    jest
      .spyOn(node as any, 'selectiveInterpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
    jest.spyOn(node as any, 'loadContactData').mockResolvedValue({});
    jest.spyOn(node as any, 'loadSessionVariables').mockResolvedValue({});

    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockGetConversation.mockReset();
  });

  it('equals: matches when the conversation is currently in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('equals: does not match when the conversation is in a different stage', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_Y));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('not_equals: does not match when the conversation is in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('not_equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('not_equals: matches when the conversation is in a different stage', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_Y));

    const result = await node.execute(inputWith('not_equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('multi-pipeline: matches when ANY pipeline is currently in stage X', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages('other-stage', STAGE_X));

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('null-safety: no conversation in scope → equals is false, no crash', async () => {
    jest.spyOn(node as any, 'loadConversationData').mockResolvedValue(null);

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('null-safety: conversation without pipeline items → equals is false', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue({ pipelines: [] });

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('no target stage selected → never matches, even with not_equals', async () => {
    jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(conversationInStages(STAGE_X));

    const result = await node.execute(inputWith('not_equals', ''));

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('does not load conversation data when no condition uses a conversation field', async () => {
    const loadSpy = jest
      .spyOn(node as any, 'loadConversationData')
      .mockResolvedValue(null);

    const contactInput: ConditionalNodeInput = {
      nodeId: 'n1',
      contactId: 'c1',
      conversationId: 'conv-1',
      sessionId: 's1',
      nodeData: {
        paths: [
          {
            id: 'p1',
            name: 'Contact path',
            conditions: [
              {
                id: 'cond-1',
                type: 'contact',
                field: '{{contact.email}}',
                operator: 'equals',
                value: 'a@b.com',
              },
            ],
            logicalOperator: 'AND',
          },
        ],
      },
    };

    await node.execute(contactInput);

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('integration: resolves the stage through the real loadConversationData, unwrapping the success_response envelope', async () => {
    // No loadConversationData spy here — exercise the real seam. getConversation
    // returns the CRM envelope ({ success, data: <conversation>, meta }) wrapped
    // by executeRequest as CrmApiResponse.data, so the stage lives at data.data.
    const conversationBody = {
      success: true,
      data: {
        pipelines: [{ id: 'pl1', name: 'Sales', stages: [{ id: STAGE_X }] }],
      },
      meta: {},
    };
    mockGetConversation.mockResolvedValue({
      success: true,
      data: conversationBody,
    });

    const result = await node.execute(inputWith('equals', STAGE_X));

    expect(mockGetConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
    });
    expect((result as any).nextNodeHandle).toBe('p1');
  });
});

describe('ConditionalNode — {{contact.customAttributes.*}}', () => {
  let node: ConditionalNode;

  // Loaded contact shape (HydratedContact): customAttributes keyed by
  // attribute_key slug.
  const CONTACT = {
    name: 'Acme',
    email: 'a@b.com',
    phoneNumber: '+5511999999999',
    identifier: 'ext-42',
    customAttributes: { plan_interest: 'Enterprise' },
  };

  const inputWith = (
    field: string,
    operator: string,
    value: any,
    type: 'trigger' | 'contact' | 'system' | 'custom' = 'contact',
  ): ConditionalNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    nodeData: {
      paths: [
        {
          id: 'p1',
          name: 'Contact attr path',
          conditions: [
            { id: 'cond-1', type, field, operator: operator as any, value },
          ],
          logicalOperator: 'AND',
        },
      ],
    },
  });

  beforeEach(() => {
    node = new ConditionalNode();

    jest
      .spyOn(node as any, 'selectiveInterpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
    jest.spyOn(node as any, 'loadContactData').mockResolvedValue(CONTACT);
    jest.spyOn(node as any, 'loadSessionVariables').mockResolvedValue({});

    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('matches when the contact custom attribute equals the expected value', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.plan_interest}}', 'equals', 'Enterprise'),
    );

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('does not match when the custom attribute differs from the expected value', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.plan_interest}}', 'equals', 'SMB'),
    );

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('missing custom attribute resolves to undefined → no match (no crash)', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.unknown}}', 'equals', 'whatever'),
    );

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('regression: single-level {{contact.email}} still resolves', async () => {
    const result = await node.execute(
      inputWith('{{contact.email}}', 'equals', 'a@b.com'),
    );

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('alias: {{contact.phone}} resolves against the hydrated phoneNumber field', async () => {
    const result = await node.execute(
      inputWith('{{contact.phone}}', 'equals', '+5511999999999'),
    );

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('is_empty: matches when the custom attribute is absent', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.unknown}}', 'is_empty', ''),
    );

    expect(result.success).toBe(true);
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('is_not_empty: does not match when the custom attribute is absent', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.unknown}}', 'is_not_empty', ''),
    );

    expect((result as any).nextNodeHandle).toBe('else');
  });

  it('is_not_empty: matches when the custom attribute is present', async () => {
    const result = await node.execute(
      inputWith('{{contact.customAttributes.plan_interest}}', 'is_not_empty', ''),
    );

    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('skips the CRM contact round-trip when conditions only read session variables', async () => {
    const loadSpy = jest.spyOn(node as any, 'loadContactData');
    jest
      .spyOn(node as any, 'loadSessionVariables')
      .mockResolvedValue({ tier: 'gold' });

    const variableOnlyInput: ConditionalNodeInput = {
      nodeId: 'n1',
      contactId: 'c1',
      sessionId: 's1',
      nodeData: {
        paths: [
          {
            id: 'p1',
            name: 'Variable path',
            conditions: [
              {
                id: 'cond-1',
                type: 'custom',
                field: '{{tier}}',
                operator: 'equals',
                value: 'gold',
              },
            ],
            logicalOperator: 'AND',
          },
        ],
      },
    };

    const result = await node.execute(variableOnlyInput);

    expect(loadSpy).not.toHaveBeenCalled();
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('still loads the contact for a type:contact condition selected by name only', async () => {
    const loadSpy = jest.spyOn(node as any, 'loadContactData');

    // `field` is a bare contact attribute name (no {{contact.*}} wrapper), so
    // gating must fall back to `type: 'contact'` to know it needs the contact.
    const result = await node.execute(
      inputWith('email', 'equals', 'a@b.com', 'contact'),
    );

    expect(loadSpy).toHaveBeenCalled();
    expect((result as any).nextNodeHandle).toBe('p1');
  });

  it('routing: contact-attribute field on a non-contact-typed condition still matches', async () => {
    // Proves the pre-switch {{contact.*}} handling — not the `type` switch —
    // drives contact resolution. The picker is shared across condition types,
    // so a contact attribute may be selected on a `system`/`custom` condition.
    const result = await node.execute(
      inputWith(
        '{{contact.customAttributes.plan_interest}}',
        'equals',
        'Enterprise',
        'system',
      ),
    );

    expect((result as any).nextNodeHandle).toBe('p1');
  });
});

describe('ConditionalNode — EVO-1913: surfaces swallowed hydration errors', () => {
  let node: ConditionalNode;
  let errorSpy: jest.SpyInstance;

  const contactInput = (): ConditionalNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    nodeData: {
      paths: [
        {
          id: 'p1',
          name: 'Contact attr path',
          conditions: [
            {
              id: 'cond-1',
              type: 'contact',
              field: '{{contact.customAttributes.plan_interest}}',
              operator: 'equals' as any,
              value: 'Enterprise',
            },
          ],
          logicalOperator: 'AND',
        },
      ],
    },
  });

  beforeEach(() => {
    node = new ConditionalNode();

    jest
      .spyOn(node as any, 'selectiveInterpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);
    jest.spyOn(node as any, 'loadSessionVariables').mockResolvedValue({});

    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a CRM hydration failure fails the node (NOT a silent route to ELSE) and logs ERROR', async () => {
    jest
      .spyOn(node as any, 'loadContactData')
      .mockRejectedValue(new Error('CRM unavailable'));

    const result = await node.execute(contactInput());

    // Previously this swallowed to {} → every contact-attr condition false →
    // nextNodeHandle 'else' with success:true. Now it must surface as a failure.
    expect(result.success).toBe(false);
    expect((result as any).nextNodeHandle).not.toBe('else');
    expect((result as any).error).toContain('CRM unavailable');
  });

  it('loadContactData re-throws with an ERROR log on a CRM/import failure', async () => {
    // The dynamic CrmClientService import is mocked (top-of-file) to a client
    // without findById; ContactsClientService.findById therefore throws,
    // exercising the catch branch.
    await expect(
      (node as any).loadContactData('c1'),
    ).rejects.toThrow(/Failed to load contact data/);

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to load contact data for condition evaluation',
      expect.objectContaining({ contactId: 'c1' }),
    );
  });
});
