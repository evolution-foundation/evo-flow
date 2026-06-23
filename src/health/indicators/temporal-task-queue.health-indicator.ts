import { Injectable } from '@nestjs/common';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { JourneyExecutionPollerService } from '../../modules/temporal/services/journey-execution-poller.service';

/**
 * Readiness probe for the `journey-execution` Temporal task queue (EVO-1764).
 *
 * Reports `down` only when the queue-health poller has *confirmed* zero WORKFLOW
 * pollers sustained past the configured threshold — i.e. there is genuinely no
 * executor for triggered journeys. Reads the poller's cached snapshot (no I/O),
 * so the sustained semantics + the "stale ≠ down" rule (a Temporal outage is not
 * "no worker") live in one place and the probe can never hang.
 */
@Injectable()
export class TemporalTaskQueueIndicator implements HealthIndicator {
  readonly name = 'temporal-journey-queue';

  constructor(private readonly poller: JourneyExecutionPollerService) {}

  // Not `async`: the only work is a synchronous, cached read, so we return a
  // resolved Promise to satisfy the HealthIndicator contract without an idle
  // await. Still never rejects (the contract's hard rule).
  check(): Promise<IndicatorResult> {
    try {
      const status = this.poller.getStatus();
      if (status.healthy) {
        return Promise.resolve({ name: this.name, status: 'up' });
      }
      return Promise.resolve({
        name: this.name,
        status: 'down',
        error: 'no WORKFLOW pollers on journey-execution',
        detail: {
          workflowPollers: status.workflowPollers,
          zeroSince: status.zeroSince,
          sustainedZeroMs: status.sustainedZeroMs,
        },
      });
    } catch (err) {
      return Promise.resolve({
        name: this.name,
        status: 'down',
        error: (err as Error).message,
      });
    }
  }
}
