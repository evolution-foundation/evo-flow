import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

@Injectable()
export class ContactCreatedTrigger extends BaseTrigger {
  constructor() {
    super('ContactCreated');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    // Debug log to see trigger structure
    this.logger.debug(`🔧 ContactCreatedTrigger debug - trigger object:`, {
      triggerType: trigger.type,
      triggerMetadata: trigger.metadata,
      triggerConfig: trigger.config,
      triggerConditions: trigger.conditions,
    });

    // The CRM emits `contact.created` (dotted, canonical); older producers used
    // the short `contact_created`. Accept both (EVO-1826), like LabelTrigger.
    const isContactCreated =
      event.eventName === 'contact.created' ||
      event.eventName === 'contact_created';

    if (!isContactCreated) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event is not a contact-created event: ${event.eventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Check contact field filters if specified
    const config = this.getTriggerConfig(trigger);
    const contactFields =
      config.contactFields ||
      trigger.contactFields ||
      trigger.metadata?.contactFields;

    if (
      contactFields &&
      Array.isArray(contactFields) &&
      contactFields.length > 0
    ) {
      const contactFieldsMatch = this.matchesContactFields(
        event,
        contactFields,
      );
      const result: TriggerMatchResult = {
        matches: contactFieldsMatch.matches,
        reason: contactFieldsMatch.reason,
        metadata: {
          eventName: event.eventName,
          fieldsChecked: contactFields.length,
        },
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const result: TriggerMatchResult = {
      matches: true,
      reason: `Event matches contact-created: ${event.eventName}`,
      metadata: {
        eventName: event.eventName,
      },
    };

    this.logMatch(event, journey, result);
    return result;
  }

  private matchesContactFields(
    event: JourneyTriggerEvent,
    requiredFields: any[],
  ): TriggerMatchResult {
    // Parse contact traits (they come as JSON string)
    let contactTraits: Record<string, any> = {};
    try {
      contactTraits = JSON.parse(event.traits || '{}');
    } catch (error) {
      return {
        matches: false,
        reason: `Failed to parse contact traits: ${error.message}`,
      };
    }

    this.logger.debug(
      `🔍 Checking ${requiredFields.length} required contact fields against:`,
      contactTraits,
    );

    // Check all required fields
    for (const requiredField of requiredFields) {
      const fieldResult = this.matchesContactField(
        contactTraits,
        requiredField,
      );
      if (!fieldResult.matches) {
        return {
          matches: false,
          reason: `Contact field mismatch: ${requiredField.field} ${requiredField.operator} ${requiredField.value} - ${fieldResult.reason}`,
        };
      } else {
        this.logger.debug(
          `✅ Contact field match: ${requiredField.field} ${requiredField.operator} ${requiredField.value}`,
        );
      }
    }

    return {
      matches: true,
      reason: `All ${requiredFields.length} contact fields match`,
    };
  }

  private matchesContactField(
    contactTraits: Record<string, any>,
    requiredField: any,
  ): TriggerMatchResult {
    const actualValue = this.getNestedProperty(
      contactTraits,
      requiredField.field,
    );
    const expectedValue = requiredField.value;
    const operator = requiredField.operator;

    this.logger.debug(
      `🔍 Comparing contact field: ${actualValue} (${typeof actualValue}) ${operator} ${expectedValue} (${typeof expectedValue})`,
    );

    switch (operator) {
      case 'equals':
        return {
          matches: actualValue === expectedValue,
          reason: `${actualValue} ${actualValue === expectedValue ? '===' : '!=='} ${expectedValue}`,
        };

      case 'not_equals':
        return {
          matches: actualValue !== expectedValue,
          reason: `${actualValue} ${actualValue !== expectedValue ? '!==' : '==='} ${expectedValue}`,
        };

      case 'contains':
        const containsResult =
          typeof actualValue === 'string' &&
          actualValue.includes(expectedValue);
        return {
          matches: containsResult,
          reason: `"${actualValue}" ${containsResult ? 'contains' : 'does not contain'} "${expectedValue}"`,
        };

      case 'not_contains':
        const notContainsResult =
          typeof actualValue === 'string' &&
          !actualValue.includes(expectedValue);
        return {
          matches: notContainsResult,
          reason: `"${actualValue}" ${notContainsResult ? 'does not contain' : 'contains'} "${expectedValue}"`,
        };

      case 'exists':
        const existsResult =
          actualValue !== undefined &&
          actualValue !== null &&
          actualValue !== '';
        return {
          matches: existsResult,
          reason: `${requiredField.field} ${existsResult ? 'exists' : 'does not exist'}`,
        };

      case 'not_exists':
        const notExistsResult =
          actualValue === undefined ||
          actualValue === null ||
          actualValue === '';
        return {
          matches: notExistsResult,
          reason: `${requiredField.field} ${notExistsResult ? 'does not exist' : 'exists'}`,
        };

      default:
        return {
          matches: false,
          reason: `Unsupported contact field operator: ${operator}`,
        };
    }
  }
}
