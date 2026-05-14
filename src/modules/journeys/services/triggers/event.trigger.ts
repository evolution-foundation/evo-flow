import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

export interface JourneyEventProperty {
  path: string;
  operator: {
    type:
      | 'Equals'
      | 'NotEquals'
      | 'Contains'
      | 'NotContains'
      | 'GreaterThan'
      | 'GreaterThanOrEqual'
      | 'LessThan'
      | 'LessThanOrEqual'
      | 'Exists'
      | 'NotExists';
    value?: any;
  };
}

@Injectable()
export class EventTrigger extends BaseTrigger {
  constructor() {
    super('Event');
  }

  matches(
    event: JourneyTriggerEvent,
    trigger: any,
    journey: any,
  ): TriggerMatchResult {
    // Debug log to see trigger structure
    this.logger.debug(`🔧 EventTrigger debug - trigger object:`, {
      triggerType: trigger.type,
      triggerMetadata: trigger.metadata,
      triggerConfig: trigger.config,
      triggerConditions: trigger.conditions,
      triggerEventName: trigger.eventName,
    });

    // Check event name first
    const config = this.getTriggerConfig(trigger);
    const targetEventName =
      config.eventName || trigger.eventName || trigger.conditions?.eventName || trigger.eventTemplate;

    this.logger.debug(
      `🔧 EventTrigger debug - extracted eventName: "${targetEventName}"`,
    );

    if (!targetEventName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Event trigger missing eventName configuration',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    if (event.eventName !== targetEventName) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event name mismatch: ${event.eventName} !== ${targetEventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    this.logger.debug(
      `🔍 Event name match: ${event.eventName} === ${targetEventName}`,
    );

    // Check event properties if specified
    const eventProperties = config.eventProperties || trigger.eventProperties;
    if (
      eventProperties &&
      Array.isArray(eventProperties) &&
      eventProperties.length > 0
    ) {
      const propertiesMatch = this.matchesEventProperties(
        event,
        eventProperties,
      );
      const result: TriggerMatchResult = {
        matches: propertiesMatch.matches,
        reason: propertiesMatch.reason,
        metadata: {
          eventName: targetEventName,
          propertiesChecked: eventProperties.length,
        },
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const result: TriggerMatchResult = {
      matches: true,
      reason: `Event name matches: ${targetEventName}`,
      metadata: { eventName: targetEventName },
    };
    this.logMatch(event, journey, result);
    return result;
  }

  private matchesEventProperties(
    event: JourneyTriggerEvent,
    requiredProperties: JourneyEventProperty[],
  ): TriggerMatchResult {
    // Parse event properties (they come as JSON string)
    let eventProperties: Record<string, any> = {};
    try {
      eventProperties = JSON.parse(event.properties || '{}');
    } catch (error) {
      return {
        matches: false,
        reason: `Failed to parse event properties: ${error.message}`,
      };
    }

    this.logger.debug(
      `🔍 Checking ${requiredProperties.length} required properties against:`,
      eventProperties,
    );

    // Check all required properties
    for (const requiredProp of requiredProperties) {
      const propertyResult = this.matchesProperty(
        eventProperties,
        requiredProp,
      );
      if (!propertyResult.matches) {
        return {
          matches: false,
          reason: `Property mismatch: ${requiredProp.path} ${requiredProp.operator.type} ${requiredProp.operator.value} - ${propertyResult.reason}`,
        };
      } else {
        this.logger.debug(
          `✅ Property match: ${requiredProp.path} ${requiredProp.operator.type} ${requiredProp.operator.value}`,
        );
      }
    }

    return {
      matches: true,
      reason: `All ${requiredProperties.length} properties match`,
    };
  }

  private matchesProperty(
    eventProperties: Record<string, any>,
    requiredProp: JourneyEventProperty,
  ): TriggerMatchResult {
    const actualValue = this.getNestedProperty(
      eventProperties,
      requiredProp.path,
    );
    const expectedValue = requiredProp.operator.value;
    const operator = requiredProp.operator.type;

    this.logger.debug(
      `🔍 Comparing: ${actualValue} (${typeof actualValue}) ${operator} ${expectedValue} (${typeof expectedValue})`,
    );

    switch (operator) {
      case 'Equals':
        return {
          matches: actualValue === expectedValue,
          reason: `${actualValue} ${actualValue === expectedValue ? '===' : '!=='} ${expectedValue}`,
        };

      case 'NotEquals':
        return {
          matches: actualValue !== expectedValue,
          reason: `${actualValue} ${actualValue !== expectedValue ? '!==' : '==='} ${expectedValue}`,
        };

      case 'Contains':
        const containsResult =
          typeof actualValue === 'string' &&
          actualValue.includes(expectedValue);
        return {
          matches: containsResult,
          reason: `"${actualValue}" ${containsResult ? 'contains' : 'does not contain'} "${expectedValue}"`,
        };

      case 'NotContains':
        const notContainsResult =
          typeof actualValue === 'string' &&
          !actualValue.includes(expectedValue);
        return {
          matches: notContainsResult,
          reason: `"${actualValue}" ${notContainsResult ? 'does not contain' : 'contains'} "${expectedValue}"`,
        };

      case 'GreaterThan':
        const gtResult = Number(actualValue) > Number(expectedValue);
        return {
          matches: gtResult,
          reason: `${actualValue} ${gtResult ? '>' : '<='} ${expectedValue}`,
        };

      case 'GreaterThanOrEqual':
        const gteResult = Number(actualValue) >= Number(expectedValue);
        return {
          matches: gteResult,
          reason: `${actualValue} ${gteResult ? '>=' : '<'} ${expectedValue}`,
        };

      case 'LessThan':
        const ltResult = Number(actualValue) < Number(expectedValue);
        return {
          matches: ltResult,
          reason: `${actualValue} ${ltResult ? '<' : '>='} ${expectedValue}`,
        };

      case 'LessThanOrEqual':
        const lteResult = Number(actualValue) <= Number(expectedValue);
        return {
          matches: lteResult,
          reason: `${actualValue} ${lteResult ? '<=' : '>'} ${expectedValue}`,
        };

      case 'Exists':
        const existsResult =
          actualValue !== undefined &&
          actualValue !== null &&
          actualValue !== '';
        return {
          matches: existsResult,
          reason: `${requiredProp.path} ${existsResult ? 'exists' : 'does not exist'}`,
        };

      case 'NotExists':
        const notExistsResult =
          actualValue === undefined ||
          actualValue === null ||
          actualValue === '';
        return {
          matches: notExistsResult,
          reason: `${requiredProp.path} ${notExistsResult ? 'does not exist' : 'exists'}`,
        };

      default:
        return {
          matches: false,
          reason: `Unsupported operator: ${operator}`,
        };
    }
  }
}
