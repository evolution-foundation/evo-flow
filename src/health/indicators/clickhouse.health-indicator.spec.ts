import { ClickHouseHealthIndicator } from './clickhouse.health-indicator';
import { ClickHouseService } from '../../modules/processing/clickhouse/clickhouse.service';

describe('ClickHouseHealthIndicator', () => {
  const build = (query: jest.Mock) =>
    new ClickHouseHealthIndicator({ query } as unknown as ClickHouseService);

  it('up when SELECT 1 succeeds', async () => {
    const indicator = build(jest.fn().mockResolvedValue([{ '1': 1 }]));
    await expect(indicator.check()).resolves.toEqual({
      name: 'clickhouse',
      status: 'up',
    });
  });

  it('down with the error when the query rejects', async () => {
    const indicator = build(jest.fn().mockRejectedValue(new Error('CH down')));
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'clickhouse', status: 'down' });
    expect(result.error).toContain('CH down');
  });
});
