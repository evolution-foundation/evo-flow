import { CustomAttributeTrigger } from './custom-attribute.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('CustomAttributeTrigger', () => {
  let trigger: CustomAttributeTrigger;

  const ATTR = 'Plan Interest';
  const journey = { id: 'journey-1' };

  // The CRM emits `contact.custom_attribute.changed` as an identify DTO, so the
  // payload lands in `traits` (EVO-1839). Default the fixtures to that shape.
  const event = (
    eventName: string,
    traits: Record<string, any> = { attributeName: ATTR, attributeValue: 'gold' },
    properties: Record<string, any> = {},
  ): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'identify',
    properties: JSON.stringify(properties),
    traits: JSON.stringify(traits),
    timestamp: '2026-06-22T00:00:00.000Z',
  });

  const triggerWith = (metadata: Record<string, any>) => ({
    type: 'CustomAttribute',
    metadata,
  });

  beforeEach(() => {
    trigger = new CustomAttributeTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches on the canonical dotted event with the payload in traits', () => {
    const result = trigger.matches(
      event('contact.custom_attribute.changed'),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('matches on the legacy underscore event name (accept-both)', () => {
    const result = trigger.matches(
      event('custom_attribute_changed'),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('matches when the payload is in properties (back-compat)', () => {
    const result = trigger.matches(
      event(
        'contact.custom_attribute.changed',
        {},
        { attributeName: ATTR, attributeValue: 'gold' },
      ),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('does not match when the attribute name differs', () => {
    const result = trigger.matches(
      event('contact.custom_attribute.changed', {
        attributeName: 'Other Attr',
        attributeValue: 'gold',
      }),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('does not match when a configured value filter differs', () => {
    const result = trigger.matches(
      event('contact.custom_attribute.changed', {
        attributeName: ATTR,
        attributeValue: 'silver',
      }),
      triggerWith({ customAttributeName: ATTR, customAttributeValue: 'gold' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('does not match an unrelated event (reason names the event)', () => {
    const result = trigger.matches(
      event('contact.created'),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(false);
    expect(result.reason).toContain('contact.created');
  });

  it('still matches a "removed" change with no attributeValue in traits (EVO-1839 F7)', () => {
    const result = trigger.matches(
      event('contact.custom_attribute.changed', {
        attributeName: ATTR,
        changeType: 'removed',
      }),
      triggerWith({ customAttributeName: ATTR }),
      journey,
    );
    expect(result.matches).toBe(true);
    // no value filter configured + no value present → no throw, name carries the match
    expect(result.metadata?.attributeValue).toBeUndefined();
  });
});
