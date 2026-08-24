import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

// Name emitted by POST /api/v1/journeys/trigger/:journeyId. Matching the whole
// `webhook.` prefix is not an option: the e-mail deliverability pipeline writes
// every provider callback to `contact_events` as `webhook.<platform>`
// (sendgrid, resend, ses, ...), and those share the journey-trigger bus.
const JOURNEY_WEBHOOK_EVENT_NAME = 'webhook.journey_trigger';

@Injectable()
export class WebhookTrigger extends BaseTrigger {
  constructor() {
    super('Webhook');
  }

  // The target name is fixed, not read off the node: the editor copies
  // `eventName` onto every trigger node whatever its type, so honouring it here
  // would let a name left behind by the Event type retarget this handler.
  matches(
    event: JourneyTriggerEvent,
    trigger: unknown,
    journey: unknown,
  ): TriggerMatchResult {
    const matches = event.eventName === JOURNEY_WEBHOOK_EVENT_NAME;

    const result: TriggerMatchResult = {
      matches,
      reason: matches
        ? `Event name matches: ${JOURNEY_WEBHOOK_EVENT_NAME}`
        : `Event name mismatch: ${event.eventName} !== ${JOURNEY_WEBHOOK_EVENT_NAME}`,
      metadata: {
        eventName: event.eventName,
        targetEventName: JOURNEY_WEBHOOK_EVENT_NAME,
      },
    };

    this.logMatch(event, journey, result);
    return result;
  }
}
