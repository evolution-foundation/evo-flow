import { DataSource } from 'typeorm';
import { PostgresHealthIndicator } from './postgres.health-indicator';

describe('PostgresHealthIndicator', () => {
  const build = (query: jest.Mock) =>
    new PostgresHealthIndicator({ query } as unknown as DataSource);

  it('returns up when SELECT 1 succeeds', async () => {
    const indicator = build(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    await expect(indicator.check()).resolves.toEqual({
      name: 'postgres',
      status: 'up',
    });
  });

  it('returns down with the error when the query rejects', async () => {
    const indicator = build(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'postgres', status: 'down' });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('never rejects', async () => {
    const indicator = build(jest.fn().mockRejectedValue(new Error('boom')));
    await expect(indicator.check()).resolves.toBeDefined();
  });
});
