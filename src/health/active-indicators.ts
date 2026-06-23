import { RunMode } from '../modules/processing/enums/run-mode.enum';
import { HealthIndicator } from './indicators/health-indicator.interface';

export interface AllIndicators {
  postgres: HealthIndicator;
  redis: HealthIndicator;
  broker: HealthIndicator;
  clickhouse: HealthIndicator;
  temporal: HealthIndicator;
}

/**
 * Indicators evaluated by `/ready` for a given RUN_MODE (EVO-1226):
 * Postgres + Redis + Broker for every mode, plus ClickHouse only for
 * `event-process` (AC4), plus the journey-execution queue-health probe only for
 * the dedicated `temporal-worker` (EVO-1764). It is deliberately NOT added in
 * `single` mode: there the worker shares the process with the API, so a
 * journey-queue dip must not 503 the whole co-located surface and risk LB
 * eviction. SINGLE still gets the signal via the `/metrics` poller gauges.
 * Pure function so the gating is unit-testable without booting the module graph.
 */
export function selectActiveIndicators(
  mode: RunMode,
  all: AllIndicators,
): HealthIndicator[] {
  const active: HealthIndicator[] = [all.postgres, all.redis, all.broker];
  if (mode === RunMode.EVENT_PROCESS) {
    active.push(all.clickhouse);
  }
  if (mode === RunMode.TEMPORAL_WORKER) {
    active.push(all.temporal);
  }
  return active;
}
