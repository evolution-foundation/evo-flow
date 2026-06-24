import { TemporalConnectivityIndicator } from './temporal-connectivity.health-indicator';

jest.mock('../../modules/processing/config/processing.config', () => ({
  getProcessingConfig: () => ({
    temporal: { temporalUnreachableSustainedMs: 60_000 },
  }),
}));

const build = (getStatus: jest.Mock) =>
  new TemporalConnectivityIndicator({ getStatus } as any);

const baseStatus = {
  healthy: true,
  workflowPollers: 2,
  activityPollers: 2,
  zeroSince: null,
  sustainedZeroMs: 0,
};

describe('TemporalConnectivityIndicator (EVO-1859)', () => {
  it('up when Temporal is reachable (not stale)', async () => {
    const indicator = build(
      jest.fn().mockReturnValue({
        ...baseStatus,
        stale: false,
        staleSince: null,
        staleSustainedMs: 0,
      }),
    );
    await expect(indicator.check()).resolves.toEqual({
      name: 'temporal-connectivity',
      status: 'up',
    });
  });

  it('up while stale but below the sustained threshold (no flap on a transient blip)', async () => {
    const indicator = build(
      jest.fn().mockReturnValue({
        ...baseStatus,
        stale: true,
        staleSince: new Date('2026-06-24T00:00:00.000Z'),
        staleSustainedMs: 15_000, // < 60s threshold
      }),
    );
    await expect(indicator.check()).resolves.toEqual({
      name: 'temporal-connectivity',
      status: 'up',
    });
  });

  it('down with structured detail on a sustained outage', async () => {
    const staleSince = new Date('2026-06-24T00:00:00.000Z');
    const indicator = build(
      jest.fn().mockReturnValue({
        ...baseStatus,
        stale: true,
        staleSince,
        staleSustainedMs: 90_000, // >= 60s threshold
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({
      name: 'temporal-connectivity',
      status: 'down',
      error: expect.stringContaining('unreachable'),
    });
    expect(result.detail).toMatchObject({ staleSince, staleSustainedMs: 90_000 });
  });

  it('never throws — a poller read failure resolves as down', async () => {
    const indicator = build(
      jest.fn(() => {
        throw new Error('boom');
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'temporal-connectivity', status: 'down' });
    expect(result.error).toContain('boom');
  });
});
