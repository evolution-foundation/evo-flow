import { TriggerNode } from './trigger.node';

describe('TriggerNode — VariableMapping resolution (EVO-1839)', () => {
  let node: TriggerNode;

  const input = (
    triggerEvent: Record<string, any>,
    variableMappings: Array<Record<string, any>>,
  ): any => ({
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    triggerEvent,
    nodeData: { label: 'Trigger', triggerType: 'CustomAttribute', variableMappings },
  });

  beforeEach(() => {
    node = new TriggerNode();
    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('resolves an event.properties.* mapping from the traits payload (identify DTO)', async () => {
    const result = await node.execute(
      input(
        {
          messageId: 'm1',
          eventName: 'contact.custom_attribute.changed',
          eventType: 'identify',
          properties: {},
          traits: { attributeName: 'Plan Interest', attributeValue: 'gold' },
          timestamp: '2026-06-22T00:00:00.000Z',
        },
        [
          {
            id: '1',
            sourcePath: 'event.properties.attributeValue',
            variableName: '{{plan}}',
          },
        ],
      ),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.plan).toBe('gold');
    // traits are also flattened as convenience vars
    expect(result.variables?.event_attributeValue).toBe('gold');
  });

  it('still resolves a properties-based mapping (regression guard for other triggers)', async () => {
    const result = await node.execute(
      input(
        {
          messageId: 'm1',
          eventName: 'contact.created',
          eventType: 'track',
          properties: { value: 'x' },
          traits: {},
          timestamp: '2026-06-22T00:00:00.000Z',
        },
        [{ id: '1', sourcePath: 'event.properties.value', variableName: '{{v}}' }],
      ),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.v).toBe('x');
  });
});
