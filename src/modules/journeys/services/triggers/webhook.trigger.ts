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
    const config = this.getTriggerConfig(trigger) as { eventName?: string };
    const node = trigger as { eventName?: string };
    const targetEventName =
      config.eventName || node.eventName || JOURNEY_WEBHOOK_EVENT_NAME;

    if (event.eventName !== targetEventName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event name mismatch: ${event.eventName} !== ${targetEventName}`,
        metadata: { eventName: event.eventName, targetEventName },
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const journeyId = (journey as { id: string }).id;
    const addressedJourneyId = this.getAddressedJourneyId(event);

    if (addressedJourneyId && addressedJourneyId !== journeyId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Webhook is addressed to journey ${addressedJourneyId}, not ${journeyId}`,
        metadata: { eventName: event.eventName, addressedJourneyId },
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const result: TriggerMatchResult = {
      matches: true,
      reason: `Event name matches: ${targetEventName}`,
      metadata: { eventName: event.eventName, targetEventName },
    };
    this.logMatch(event, journey, result);
    return result;
  }

  private getAddressedJourneyId(event: JourneyTriggerEvent): string | null {
    try {
      const properties = JSON.parse(event.properties || '{}') as {
        journeyId?: string;
      };
      return properties.journeyId || null;
    } catch (error) {
      this.logger.debug(
        `Could not read journeyId from event properties: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
