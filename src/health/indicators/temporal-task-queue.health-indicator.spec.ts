import { TemporalTaskQueueIndicator } from './temporal-task-queue.health-indicator';

const build = (getStatus: jest.Mock) =>
  new TemporalTaskQueueIndicator({ getStatus } as any);

describe('TemporalTaskQueueIndicator (EVO-1764)', () => {
  it('up when the poller reports healthy', async () => {
    const indicator = build(
      jest.fn().mockReturnValue({
        healthy: true,
        workflowPollers: 2,
        activityPollers: 2,
        zeroSince: null,
        sustainedZeroMs: 0,
        stale: false,
      }),
    );
    await expect(indicator.check()).resolves.toEqual({
      name: 'temporal-journey-queue',
      status: 'up',
    });
  });

  it('down with structured detail on a confirmed sustained-zero', async () => {
    const zeroSince = new Date('2026-06-23T00:00:00.000Z');
    const indicator = build(
      jest.fn().mockReturnValue({
        healthy: false,
        workflowPollers: 0,
        activityPollers: 0,
        zeroSince,
        sustainedZeroMs: 90_000,
        stale: false,
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({
      name: 'temporal-journey-queue',
      status: 'down',
      error: expect.stringContaining('no WORKFLOW pollers'),
    });
    expect(result.detail).toMatchObject({
      workflowPollers: 0,
      zeroSince,
      sustainedZeroMs: 90_000,
    });
  });

  it('never throws — a poller read failure resolves as down', async () => {
    const indicator = build(
      jest.fn(() => {
        throw new Error('boom');
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({
      name: 'temporal-journey-queue',
      status: 'down',
    });
    expect(result.error).toContain('boom');
  });
});
