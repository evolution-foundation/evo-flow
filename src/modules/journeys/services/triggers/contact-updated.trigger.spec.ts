import { ContactUpdatedTrigger } from './contact-updated.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('ContactUpdatedTrigger', () => {
  let trigger: ContactUpdatedTrigger;

  const journey = { id: 'journey-1' };

  const event = (
    eventName: string,
    traits: Record<string, any> = {},
  ): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'identify',
    properties: '{}',
    traits: JSON.stringify(traits),
    timestamp: '2026-06-18T00:00:00.000Z',
  });

  const triggerWith = (metadata: Record<string, any> = {}) => ({
    type: 'ContactUpdated',
    metadata,
  });

  beforeEach(() => {
    trigger = new ContactUpdatedTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches the canonical dotted event contact.updated (EVO-1826)', () => {
    expect(
      trigger.matches(event('contact.updated'), triggerWith(), journey).matches,
    ).toBe(true);
  });

  it('matches the legacy underscore event contact_updated', () => {
    expect(
      trigger.matches(event('contact_updated'), triggerWith(), journey).matches,
    ).toBe(true);
  });

  it('does not match a non-contact-updated event', () => {
    expect(
      trigger.matches(event('contact.created'), triggerWith(), journey).matches,
    ).toBe(false);
  });

  it('applies contact-field filters when configured', () => {
    const t = triggerWith({
      contactFields: [{ field: 'phone', operator: 'exists' }],
    });
    expect(
      trigger.matches(event('contact.updated', { phone: '+5511' }), t, journey)
        .matches,
    ).toBe(true);
    expect(
      trigger.matches(event('contact.updated', {}), t, journey).matches,
    ).toBe(false);
  });
});
