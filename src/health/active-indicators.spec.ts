import { selectActiveIndicators, AllIndicators } from './active-indicators';
import { RunMode } from '../modules/processing/enums/run-mode.enum';
import { HealthIndicator } from './indicators/health-indicator.interface';

const stub = (name: string): HealthIndicator => ({
  name,
  check: () => Promise.resolve({ name, status: 'up' }),
});

const all: AllIndicators = {
  postgres: stub('postgres'),
  redis: stub('redis'),
  broker: stub('broker'),
  clickhouse: stub('clickhouse'),
  temporal: stub('temporal-journey-queue'),
  temporalConnectivity: stub('temporal-connectivity'),
};

const names = (mode: RunMode) =>
  selectActiveIndicators(mode, all).map((i) => i.name);

describe('selectActiveIndicators', () => {
  it('event-process includes ClickHouse (AC4)', () => {
    expect(names(RunMode.EVENT_PROCESS)).toEqual([
      'postgres',
      'redis',
      'broker',
      'clickhouse',
    ]);
  });

  it.each([
    RunMode.CAMPAIGN_PACKER,
    RunMode.CAMPAIGN_SENDER,
    RunMode.CAMPAIGN_TRACKER,
    RunMode.EVENT_RECEIVER,
    RunMode.API,
    // SINGLE deliberately excludes the temporal probe so a journey-queue dip
    // does not 503 the co-located API (EVO-1764).
    RunMode.SINGLE,
    RunMode.CAMPAIGN_WORKER,
  ])('%s excludes ClickHouse + Temporal, keeps the base trio', (mode) => {
    expect(names(mode)).toEqual(['postgres', 'redis', 'broker']);
  });

  // EVO-1764 (AC9): the journey-execution queue-health probe is added only for
  // the dedicated temporal-worker (NOT single — see selectActiveIndicators).
  // EVO-1859: plus the separate temporal-connectivity probe in the same mode.
  it('temporal-worker includes the queue-health + connectivity probes (EVO-1764/EVO-1859)', () => {
    expect(names(RunMode.TEMPORAL_WORKER)).toEqual([
      'postgres',
      'redis',
      'broker',
      'temporal-journey-queue',
      'temporal-connectivity',
    ]);
  });
});
