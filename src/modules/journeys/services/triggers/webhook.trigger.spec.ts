import { WebhookTrigger } from './webhook.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('WebhookTrigger', () => {
  let trigger: WebhookTrigger;

  const journey = { id: 'journey-1' };

  const event = (
    eventName: string,
    properties: Record<string, unknown> = {},
  ): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'track',
    properties: JSON.stringify(properties),
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

  describe('target event name resolution', () => {
    it('honours an eventName configured in metadata', () => {
      const configured = webhookTrigger({ eventName: 'webhook.sendgrid' });

      expect(
        trigger.matches(event('webhook.sendgrid'), configured, journey).matches,
      ).toBe(true);
      expect(
        trigger.matches(event('webhook.journey_trigger'), configured, journey)
          .matches,
      ).toBe(false);
    });

    it('honours an eventName set directly on the node', () => {
      const node = { type: 'Webhook', eventName: 'webhook.custom' };

      expect(
        trigger.matches(event('webhook.custom'), node, journey).matches,
      ).toBe(true);
    });

    // EventTrigger reads this path too; a handler that ignored it would leave the
    // node silently never firing.
    it('honours an eventName under conditions, like EventTrigger does', () => {
      const node = {
        type: 'Webhook',
        conditions: { eventName: 'webhook.custom' },
      };

      expect(
        trigger.matches(event('webhook.custom'), node, journey).matches,
      ).toBe(true);
    });

    it.each([
      ['blank', '   '],
      ['empty', ''],
    ])('treats a %s configured eventName as unset', (_label, eventName) => {
      const result = trigger.matches(
        event('webhook.journey_trigger'),
        webhookTrigger({ eventName }),
        journey,
      );

      expect(result.matches).toBe(true);
    });

    it('trims a configured eventName', () => {
      expect(
        trigger.matches(
          event('webhook.custom'),
          webhookTrigger({ eventName: '  webhook.custom  ' }),
          journey,
        ).matches,
      ).toBe(true);
    });
  });

  describe('call-site robustness', () => {
    // journey-trigger-processor.service.ts calls handlers with `{}` as the journey
    // when it evaluates wait conditions; matching must not depend on journey.id.
    it('matches with the empty journey the wait-condition call site passes', () => {
      const waitConditions = {
        eventType: 'webhook',
        eventName: 'webhook.journey_trigger',
      };

      expect(
        trigger.matches(
          // The manual-trigger emitter always stamps journeyId into properties.
          event('webhook.journey_trigger', { journeyId: 'journey-9' }),
          waitConditions,
          {},
        ).matches,
      ).toBe(true);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])(
      'falls back to the default event name for a %s trigger',
      (_label, node) => {
        expect(
          trigger.matches(event('webhook.journey_trigger'), node, journey)
            .matches,
        ).toBe(true);
      },
    );
  });
});
