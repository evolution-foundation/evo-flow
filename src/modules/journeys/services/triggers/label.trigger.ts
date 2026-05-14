import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

@Injectable()
export class LabelTrigger extends BaseTrigger {
  constructor() {
    super('Label');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    // Debug log to see trigger structure
    this.logger.debug(`🔧 LabelTrigger debug - trigger object:`, {
      triggerType: trigger.type,
      triggerMetadata: trigger.metadata,
      triggerConfig: trigger.config,
      triggerConditions: trigger.conditions,
    });

    // Check if it's a label event (label_added or label_removed)
    const isLabelEvent =
      event.eventName === 'label_added' || event.eventName === 'label_removed';

    if (!isLabelEvent) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event is not a label event: ${event.eventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Get label ID from trigger config
    const config = this.getTriggerConfig(trigger);
    const targetLabelId =
      config.labelId ||
      trigger.labelId ||
      trigger.conditions?.labelId ||
      trigger.metadata?.labelId;

    if (!targetLabelId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Label trigger missing labelId configuration',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Parse event properties to get the label ID from the event
    let eventProperties: Record<string, any> = {};
    try {
      eventProperties = JSON.parse(event.properties || '{}');
    } catch (error) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Failed to parse event properties: ${error.message}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const eventLabelId = eventProperties.labelId;
    const eventLabelName = eventProperties.labelName;

    if (!eventLabelId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Label event missing labelId in properties',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Check if label IDs match (compare both labelId and labelName for flexibility)
    const labelMatches =
      eventLabelId === targetLabelId ||
      eventLabelName === targetLabelId ||
      eventLabelName === trigger.metadata?.labelName;

    if (!labelMatches) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Label mismatch: event labelId="${eventLabelId}" labelName="${eventLabelName}" !== target="${targetLabelId}"`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Label trigger matches!
    const result: TriggerMatchResult = {
      matches: true,
      reason: `Label event matches: ${event.eventName} for label ${eventLabelId} (${eventLabelName})`,
      metadata: {
        eventName: event.eventName,
        labelId: eventLabelId,
        labelName: eventLabelName,
      },
    };
    this.logMatch(event, journey, result);
    return result;
  }
}
