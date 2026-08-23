import { WebhookTrigger } from './webhook.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('WebhookTrigger', () => {
  let trigger: WebhookTrigger;

  const journey = { id: 'journey-1' };

  const event = (
    eventName: string,
    properties: Record<string, any> = {},
  ): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'track',
    properties: JSON.stringify(properties),
    timestamp: '2026-08-23T00:00:00.000Z',
  });

  const webhookTrigger = (metadata: Record<string, any> = {}) => ({
    type: 'Webhook',
    metadata,
  });

  beforeEach(() => {
    trigger = new WebhookTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches the event emitted by the journey trigger endpoint', () => {
    const result = trigger.matches(
      event('webhook.journey_trigger', { journeyId: journey.id }),
      webhookTrigger(),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it.each([
    'webhook.sendgrid',
    'webhook.resend',
    'webhook.ses',
    'webhook.unknown',
  ])('does NOT match the e-mail deliverability event %s', (eventName) => {
    const result = trigger.matches(event(eventName), webhookTrigger(), journey);
    expect(result.matches).toBe(false);
  });

  it('does NOT match a webhook addressed to another journey', () => {
    const result = trigger.matches(
      event('webhook.journey_trigger', { journeyId: 'journey-2' }),
      webhookTrigger(),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('matches when the event carries no journeyId', () => {
    const result = trigger.matches(
      event('webhook.journey_trigger'),
      webhookTrigger(),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('honours an eventName configured on the trigger', () => {
    const configured = webhookTrigger({ eventName: 'webhook.sendgrid' });

    expect(
      trigger.matches(event('webhook.sendgrid'), configured, journey).matches,
    ).toBe(true);
    expect(
      trigger.matches(event('webhook.journey_trigger'), configured, journey)
        .matches,
    ).toBe(false);
  });

  it('does not throw on unparseable event properties', () => {
    const broken: JourneyTriggerEvent = {
      ...event('webhook.journey_trigger'),
      properties: '{not json',
    };

    expect(trigger.matches(broken, webhookTrigger(), journey).matches).toBe(
      true,
    );
  });
});
