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

    // The CRM emits `contact.label.added` / `contact.label.removed`; older
    // producers used the short `label_added` / `label_removed`. Accept both.
    const isLabelEvent = [
      'label_added',
      'label_removed',
      'contact.label.added',
      'contact.label.removed',
    ].includes(event.eventName);

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

    // `contact.label.added` is an `identify` event, so the label payload lands
    // in `traits`, not `properties`. Read both and fall back to traits.
    let eventProperties: Record<string, any> = {};
    let eventTraits: Record<string, any> = {};
    try {
      eventProperties = JSON.parse(event.properties || '{}');
      eventTraits = JSON.parse(event.traits || '{}');
    } catch (error) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Failed to parse event properties: ${error.message}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const eventLabelId = eventProperties.labelId ?? eventTraits.labelId;
    const eventLabelName = eventProperties.labelName ?? eventTraits.labelName;

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

    // EVO-1763: honor the configured action. Fire only on the event matching
    // labelAction (applied ↔ *added, removed ↔ *removed). Triggers persisted
    // before the action was sent default to 'applied' (the editor/canvas default).
    const configuredAction: 'applied' | 'removed' =
      config.labelAction || trigger.conditions?.labelAction || 'applied';
    const eventIsApplied =
      event.eventName === 'label_added' ||
      event.eventName === 'contact.label.added';
    const actionMatches =
      configuredAction === 'applied' ? eventIsApplied : !eventIsApplied;

    if (!actionMatches) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Label action mismatch: event "${event.eventName}" does not match configured action "${configuredAction}"`,
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
