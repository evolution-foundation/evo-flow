import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

@Injectable()
export class SegmentTrigger extends BaseTrigger {
  constructor() {
    super('Segment');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    // Debug log to see trigger structure
    this.logger.debug(`🔧 SegmentTrigger debug - trigger object:`, {
      triggerType: trigger.type,
      triggerMetadata: trigger.metadata,
      triggerConfig: trigger.config,
      triggerConditions: trigger.conditions,
    });

    const config = this.getTriggerConfig(trigger);

    // For segment triggers, we need to check:
    // 1. If it's a segment change event (segment.entered or segment.exited)
    // 2. If the segmentId matches

    const isSegmentEvent =
      event.eventName === 'segment_entered' ||
      event.eventName === 'segment_exited';

    if (!isSegmentEvent) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event is not a segment event: ${event.eventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Get segment ID from trigger config
    const targetSegmentId =
      config.segmentId || trigger.segmentId || trigger.conditions?.segmentId;

    if (!targetSegmentId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Segment trigger missing segmentId configuration',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Parse event properties to get the segment ID from the event
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

    const eventSegmentId =
      eventProperties.segmentId || eventProperties.segment_id;

    if (!eventSegmentId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: 'Segment event missing segmentId in properties',
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Check if segment IDs match
    if (eventSegmentId !== targetSegmentId) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Segment ID mismatch: ${eventSegmentId} !== ${targetSegmentId}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // EVO-1763: honor the configured action (entered ↔ segment_entered, exited ↔
    // segment_exited). Triggers persisted before the frontend sent segmentAction
    // default to 'entered' (the editor/canvas default).
    const configuredAction: 'entered' | 'exited' =
      config.segmentAction || trigger.conditions?.segmentAction || 'entered';
    const eventIsEntered = event.eventName === 'segment_entered';
    const actionMatches =
      configuredAction === 'entered' ? eventIsEntered : !eventIsEntered;

    if (!actionMatches) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Segment action mismatch: event "${event.eventName}" does not match configured action "${configuredAction}"`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    // Segment trigger matches!
    const result: TriggerMatchResult = {
      matches: true,
      reason: `Segment event matches: ${event.eventName} for segment ${targetSegmentId}`,
      metadata: {
        eventName: event.eventName,
        segmentId: targetSegmentId,
      },
    };
    this.logMatch(event, journey, result);
    return result;
  }
}
