import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

@Injectable()
export class CustomAttributeTrigger extends BaseTrigger {
  constructor() {
    super('CustomAttribute');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    // Debug log to see trigger structure
    this.logger.debug(`🔧 CustomAttributeTrigger debug - trigger object:`, {
      triggerType: trigger.type,
      triggerMetadata: trigger.metadata,
      triggerConfig: trigger.config,
      triggerConditions: trigger.conditions,
    });

    // Check if it's a custom attribute event
    const isCustomAttributeEvent =
      event.eventName === 'custom_attribute_changed';

    if (!isCustomAttributeEvent) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event is not a custom attribute event: ${event.eventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Get custom attribute configuration from trigger
    const config = this.getTriggerConfig(trigger);
    const targetAttributeName =
      config.customAttributeName ||
      trigger.customAttributeName ||
      trigger.conditions?.attributeName ||
      trigger.metadata?.customAttributeName;

    if (!targetAttributeName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason:
          'CustomAttribute trigger missing customAttributeName configuration',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Parse event properties to get the attribute details from the event
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

    const eventAttributeName = eventProperties.attributeName;
    const eventAttributeValue = eventProperties.attributeValue;
    const changeType = eventProperties.changeType; // added, modified, removed

    if (!eventAttributeName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Custom attribute event missing attributeName in properties',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Check if attribute names match
    if (eventAttributeName !== targetAttributeName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Attribute name mismatch: ${eventAttributeName} !== ${targetAttributeName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Check if attribute value matches (if specified in trigger)
    const targetAttributeValue =
      config.customAttributeValue ||
      trigger.customAttributeValue ||
      trigger.metadata?.customAttributeValue;

    if (targetAttributeValue && eventAttributeValue !== targetAttributeValue) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Attribute value mismatch: "${eventAttributeValue}" !== "${targetAttributeValue}"`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Custom attribute trigger matches!
    const result: TriggerMatchResult = {
      matches: true,
      reason: `Custom attribute event matches: ${eventAttributeName}=${eventAttributeValue} (${changeType})`,
      metadata: {
        eventName: event.eventName,
        attributeName: eventAttributeName,
        attributeValue: eventAttributeValue,
        changeType: changeType,
      },
    };
    this.logMatch(event, journey, result);
    return result;
  }
}
