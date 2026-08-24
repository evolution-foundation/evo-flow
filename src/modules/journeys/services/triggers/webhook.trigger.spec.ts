import { WebhookTrigger } from './webhook.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('WebhookTrigger', () => {
  let trigger: WebhookTrigger;

  const journey = { id: 'journey-1' };

  const event = (eventName: string): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'track',
    properties: '{}',
    timestamp: '2026-08-23T00:00:00.000Z',
  });

  const webhookTrigger = (metadata: Record<string, unknown> = {}) => ({
    type: 'Webhook',
    metadata,
  });

  beforeEach(() => {
    trigger = new WebhookTrigger();
    jest
      .spyOn(
        (trigger as unknown as { logger: { debug: () => void } }).logger,
        'debug',
      )
      .mockImplementation(() => undefined);
  });

  it('matches the event emitted by the journey trigger endpoint', () => {
    const result = trigger.matches(
      event('webhook.journey_trigger'),
      webhookTrigger(),
      journey,
    );

    expect(result).toMatchObject({
      matches: true,
      reason: 'Event name matches: webhook.journey_trigger',
      metadata: {
        eventName: 'webhook.journey_trigger',
        targetEventName: 'webhook.journey_trigger',
      },
    });
  });

  it.each([
    'webhook.sendgrid',
    'webhook.resend',
    'webhook.ses',
    'webhook.unknown',
  ])('does NOT match the e-mail deliverability event %s', (eventName) => {
    const result = trigger.matches(event(eventName), webhookTrigger(), journey);

    expect(result).toMatchObject({
      matches: false,
      reason: `Event name mismatch: ${eventName} !== webhook.journey_trigger`,
      metadata: { eventName, targetEventName: 'webhook.journey_trigger' },
    });
  });

  // The editor writes `eventName` onto every trigger node and never clears it
  // when the type changes, so a node switched from Event to Webhook carries the
  // old name in all three places a config could be read from.
  describe('a leftover eventName does not retarget the handler', () => {
    const switchedFromEventType = {
      type: 'Webhook',
      eventName: 'user.signup',
      conditions: { eventName: 'user.signup' },
      metadata: { triggerType: 'webhook', eventName: 'user.signup' },
    };

    it('ignores the leftover name', () => {
      expect(
        trigger.matches(event('user.signup'), switchedFromEventType, journey)
          .matches,
      ).toBe(false);
    });

    it('still matches the journey trigger event', () => {
      expect(
        trigger.matches(
          event('webhook.journey_trigger'),
          switchedFromEventType,
          journey,
        ).matches,
      ).toBe(true);
    });
  });

  describe('call-site robustness', () => {
    // journey-trigger-processor.service.ts calls handlers with `{}` as the journey
    // when it evaluates wait conditions; matching must not depend on journey.id.
    it('matches with the empty journey the wait-condition call site passes', () => {
      const waitConditions = { eventType: 'webhook', webhookUrl: 'https://x' };

      expect(
        trigger.matches(event('webhook.journey_trigger'), waitConditions, {})
          .matches,
      ).toBe(true);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('matches with a %s trigger', (_label, node) => {
      expect(
        trigger.matches(event('webhook.journey_trigger'), node, journey)
          .matches,
      ).toBe(true);
    });
  });
});
