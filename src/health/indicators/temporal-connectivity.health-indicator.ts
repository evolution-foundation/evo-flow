import { Injectable } from '@nestjs/common';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { JourneyExecutionPollerService } from '../../modules/temporal/services/journey-execution-poller.service';
import { getProcessingConfig } from '../../modules/processing/config/processing.config';

/**
 * Readiness probe for *connectivity to the Temporal server* (EVO-1859).
 *
 * Deliberately separate from {@link TemporalTaskQueueIndicator}: that one answers
 * "is there a worker for the journey-execution queue?" and treats a Temporal
 * outage as `stale ≠ down` so an outage is not misread as "no worker" (EVO-1764).
 * This one answers the orthogonal question "can the journey worker reach Temporal
 * at all?" and reports `down` when the queue poller has been failing
 * continuously past `temporalUnreachableSustainedMs`.
 *
 * Reuses the poller's cached `stale`/`staleSustainedMs` snapshot (no I/O, never
 * hangs). The *sustained* gate mirrors the zero-poller indicator so a benign
 * Temporal restart — from which the worker auto-recovers (EVO-1758) — does not
 * flap /ready and risk LB eviction; only a genuine, lasting outage 503s.
 */
@Injectable()
export class TemporalConnectivityIndicator implements HealthIndicator {
  readonly name = 'temporal-connectivity';

  constructor(private readonly poller: JourneyExecutionPollerService) {}

  // Not `async`: synchronous cached read returned as a resolved Promise to
  // satisfy the contract. Still never rejects (the contract's hard rule).
  check(): Promise<IndicatorResult> {
    try {
      const status = this.poller.getStatus();
      const threshold =
        getProcessingConfig().temporal!.temporalUnreachableSustainedMs;

      if (status.stale && status.staleSustainedMs >= threshold) {
        return Promise.resolve({
          name: this.name,
          status: 'down',
          error: 'Temporal server unreachable (sustained)',
          detail: {
            staleSince: status.staleSince,
            staleSustainedMs: status.staleSustainedMs,
          },
        });
      }
      return Promise.resolve({ name: this.name, status: 'up' });
    } catch (err) {
      return Promise.resolve({
        name: this.name,
        status: 'down',
        error: (err as Error).message,
      });
    }
  }
}
