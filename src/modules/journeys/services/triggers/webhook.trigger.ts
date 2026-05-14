import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

@Injectable()
export class WebhookTrigger extends BaseTrigger {
  constructor() {
    super('Webhook');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    // For webhook triggers, accept events that start with 'webhook.'
    const isWebhookEvent = event.eventName.startsWith('webhook.');

    this.logger.debug(
      `🔍 Webhook trigger check: ${event.eventName} starts with 'webhook.' = ${isWebhookEvent}`,
    );

    const result: TriggerMatchResult = {
      matches: isWebhookEvent,
      reason: isWebhookEvent
        ? `Event name starts with 'webhook.': ${event.eventName}`
        : `Event name does not start with 'webhook.': ${event.eventName}`,
      metadata: {
        eventName: event.eventName,
        isWebhookEvent,
      },
    };

    this.logMatch(event, journey, result);
    return result;
  }
}
