import { RunMode } from '../modules/processing/enums/run-mode.enum';
import { HealthIndicator } from './indicators/health-indicator.interface';

export interface AllIndicators {
  postgres: HealthIndicator;
  redis: HealthIndicator;
  broker: HealthIndicator;
  clickhouse: HealthIndicator;
}

/**
 * Indicators evaluated by `/ready` for a given RUN_MODE (EVO-1226):
 * Postgres + Redis + Broker for every mode, plus ClickHouse only for
 * `event-process` (AC4). Pure function so the gating is unit-testable without
 * booting the module graph.
 */
export function selectActiveIndicators(
  mode: RunMode,
  all: AllIndicators,
): HealthIndicator[] {
  const active: HealthIndicator[] = [all.postgres, all.redis, all.broker];
  if (mode === RunMode.EVENT_PROCESS) {
    active.push(all.clickhouse);
  }
  return active;
}
