import { ContactCreatedTrigger } from './contact-created.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('ContactCreatedTrigger', () => {
  let trigger: ContactCreatedTrigger;

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
    type: 'ContactCreated',
    metadata,
  });

  beforeEach(() => {
    trigger = new ContactCreatedTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches the canonical dotted event contact.created (EVO-1826)', () => {
    expect(
      trigger.matches(event('contact.created'), triggerWith(), journey).matches,
    ).toBe(true);
  });

  it('matches the legacy underscore event contact_created', () => {
    expect(
      trigger.matches(event('contact_created'), triggerWith(), journey).matches,
    ).toBe(true);
  });

  it('does not match a non-contact-created event', () => {
    expect(
      trigger.matches(event('contact.updated'), triggerWith(), journey).matches,
    ).toBe(false);
  });

  it('applies contact-field filters when configured', () => {
    const t = triggerWith({
      contactFields: [{ field: 'email', operator: 'exists' }],
    });
    expect(
      trigger.matches(
        event('contact.created', { email: 'a@b.com' }),
        t,
        journey,
      ).matches,
    ).toBe(true);
    expect(
      trigger.matches(event('contact.created', {}), t, journey).matches,
    ).toBe(false);
  });
});
