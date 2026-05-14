import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

export interface TriggerMatchResult {
  matches: boolean;
  reason?: string;
  metadata?: Record<string, any>;
}

export abstract class BaseTrigger {
  protected readonly logger: CustomLoggerService;

  constructor(protected readonly triggerType: string) {
    this.logger = new CustomLoggerService(`${triggerType}Trigger`);
  }

  abstract matches(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
  ): Promise<TriggerMatchResult> | TriggerMatchResult;

  protected logMatch(
    event: JourneyTriggerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journey: any,
    result: TriggerMatchResult,
  ): void {
    if (result.matches) {
      this.logger.debug(
        `✅ Event ${event.eventName} matches ${this.triggerType} trigger in journey ${(journey as { id: string }).id}`,
        { reason: result.reason, metadata: result.metadata },
      );
    } else {
      this.logger.debug(
        `❌ Event ${event.eventName} does not match ${this.triggerType} trigger in journey ${(journey as { id: string }).id}`,
        { reason: result.reason },
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getTriggerConfig(trigger: any): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return trigger.metadata || trigger.config || {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getNestedProperty(obj: Record<string, any>, path: string): any {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }
}
