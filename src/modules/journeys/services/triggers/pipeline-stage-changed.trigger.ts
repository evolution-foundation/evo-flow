import { Injectable } from '@nestjs/common';
import { BaseTrigger, TriggerMatchResult } from './base.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

const PIPELINE_STAGE_CHANGED_EVENT = 'pipeline.stage_changed';

@Injectable()
export class PipelineStageChangedTrigger extends BaseTrigger {
  constructor() {
    super('PipelineStageChanged');
  }

  matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): TriggerMatchResult {
    if (event.eventName !== PIPELINE_STAGE_CHANGED_EVENT) {
      const result: TriggerMatchResult = {
        matches: false,
        reason: `Event is not a pipeline stage change: ${event.eventName}`,
      };
      this.logMatch(event, journey, result);
      return result;
    }

    const config = this.getTriggerConfig(trigger);
    const targetPipelineId =
      config.pipelineId || trigger.pipelineId || trigger.conditions?.pipelineId;
    const targetFromStageId =
      config.fromStageId ||
      trigger.fromStageId ||
      trigger.conditions?.fromStageId;
    const targetToStageId =
      config.toStageId || trigger.toStageId || trigger.conditions?.toStageId;

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

    // Each filter is optional: an unset filter matches any value, so a trigger
    // with no filters fires on every pipeline stage change.
    const checks = [
      {
        label: 'pipeline_id',
        target: targetPipelineId,
        actual: eventProperties.pipeline_id,
      },
      {
        label: 'from_stage_id',
        target: targetFromStageId,
        actual: eventProperties.from_stage_id,
      },
      {
        label: 'to_stage_id',
        target: targetToStageId,
        actual: eventProperties.to_stage_id,
      },
    ];

    for (const check of checks) {
      if (check.target && check.actual !== check.target) {
        const result: TriggerMatchResult = {
          matches: false,
          reason: `${check.label} mismatch: ${check.actual} !== ${check.target}`,
        };
        this.logMatch(event, journey, result);
        return result;
      }
    }

    const result: TriggerMatchResult = {
      matches: true,
      reason: `Pipeline stage change matches (pipeline=${targetPipelineId || 'any'}, from=${targetFromStageId || 'any'}, to=${targetToStageId || 'any'})`,
      metadata: {
        eventName: event.eventName,
        pipelineId: eventProperties.pipeline_id,
        fromStageId: eventProperties.from_stage_id,
        toStageId: eventProperties.to_stage_id,
      },
    };
    this.logMatch(event, journey, result);
    return result;
  }
}
