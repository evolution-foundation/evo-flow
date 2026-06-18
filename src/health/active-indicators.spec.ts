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
    RunMode.SINGLE,
    RunMode.API,
  ])('%s excludes ClickHouse, keeps the base trio (AC4)', (mode) => {
    expect(names(mode)).toEqual(['postgres', 'redis', 'broker']);
  });
});
