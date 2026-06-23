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

  // The FE (CustomAttributeConfiguration) persists `attribute.*` sourcePaths —
  // never `event.properties.*` — so AC2 is only proven by resolving those.
  const attributeEvent = {
    messageId: 'm1',
    eventName: 'contact.custom_attribute.changed',
    eventType: 'identify',
    properties: {},
    traits: {
      attributeName: 'plan_interest',
      attributeValue: 'gold',
      oldValue: 'silver',
      changeType: 'modified',
    },
    timestamp: '2026-06-22T00:00:00.000Z',
  };

  it('resolves attribute.value from the traits payload (identify DTO) — AC2', async () => {
    const result = await node.execute(
      input(attributeEvent, [
        { id: '1', sourcePath: 'attribute.value', variableName: '{{plan}}' },
      ]),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.plan).toBe('gold');
    // traits are also flattened as convenience vars
    expect(result.variables?.event_attributeValue).toBe('gold');
  });

  it('resolves attribute.name / attribute.previous_value / attribute.timestamp', async () => {
    const result = await node.execute(
      input(attributeEvent, [
        { id: '1', sourcePath: 'attribute.name', variableName: '{{name}}' },
        { id: '2', sourcePath: 'attribute.previous_value', variableName: '{{prev}}' },
        { id: '3', sourcePath: 'attribute.timestamp', variableName: '{{ts}}' },
      ]),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.name).toBe('plan_interest');
    expect(result.variables?.prev).toBe('silver');
    expect(result.variables?.ts).toBe('2026-06-22T00:00:00.000Z');
  });

  it('resolves attribute-specific paths attribute.<name> and attribute.<name>_previous', async () => {
    const result = await node.execute(
      input(attributeEvent, [
        { id: '1', sourcePath: 'attribute.plan_interest', variableName: '{{cur}}' },
        { id: '2', sourcePath: 'attribute.plan_interest_previous', variableName: '{{was}}' },
      ]),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.cur).toBe('gold');
    expect(result.variables?.was).toBe('silver');
  });

  it('does not resolve an attribute-specific path for a different attribute', async () => {
    const result = await node.execute(
      input(attributeEvent, [
        { id: '1', sourcePath: 'attribute.other_attr', variableName: '{{x}}' },
      ]),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.x).toBeUndefined();
  });

  it('falls back to properties when the payload rides in properties, not traits', async () => {
    const result = await node.execute(
      input(
        {
          messageId: 'm1',
          eventName: 'custom_attribute_changed',
          eventType: 'identify',
          properties: { attributeName: 'plan_interest', attributeValue: 'gold' },
          traits: {},
          timestamp: '2026-06-22T00:00:00.000Z',
        },
        [{ id: '1', sourcePath: 'attribute.value', variableName: '{{plan}}' }],
      ),
    );

    expect(result.success).toBe(true);
    expect(result.variables?.plan).toBe('gold');
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
