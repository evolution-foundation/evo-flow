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

  matches(
    event: JourneyTriggerEvent,
    trigger: unknown,
    journey: unknown,
  ): TriggerMatchResult {
    const targetEventName = this.resolveTargetEventName(trigger);

    if (event.eventName !== targetEventName) {
      return this.decide(event, journey, {
        matches: false,
        reason: `Event name mismatch: ${event.eventName} !== ${targetEventName}`,
        metadata: { eventName: event.eventName, targetEventName },
      });
    }

    return this.decide(event, journey, {
      matches: true,
      reason: `Event name matches: ${targetEventName}`,
      metadata: { eventName: event.eventName, targetEventName },
    });
  }

  // Same resolution order EventTrigger uses, so both handlers read an identical
  // node shape identically. A blank configured name counts as unset.
  private resolveTargetEventName(trigger: unknown): string {
    const config = this.getTriggerConfig(trigger ?? {}) as {
      eventName?: string;
    };
    const node = (trigger ?? {}) as {
      eventName?: string;
      conditions?: { eventName?: string };
    };

    for (const candidate of [
      config.eventName,
      node.eventName,
      node.conditions?.eventName,
    ]) {
      const name = candidate?.trim();
      if (name) {
        return name;
      }
    }

    return JOURNEY_WEBHOOK_EVENT_NAME;
  }

  private decide(
    event: JourneyTriggerEvent,
    journey: unknown,
    result: TriggerMatchResult,
  ): TriggerMatchResult {
    this.logMatch(event, journey, result);
    return result;
  }
}
