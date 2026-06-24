import { JourneyExecutionPollerService } from './journey-execution-poller.service';

// Controlled thresholds + a stub connection so the poller is exercised without a
// real Temporal server.
jest.mock('../../processing/config/processing.config', () => ({
  getProcessingConfig: () => ({
    runMode: 'temporal-worker',
    temporal: {
      serverAddress: 'localhost:7233',
      namespace: 'default',
      queuePollIntervalMs: 15_000,
      zeroPollerSustainedMs: 60_000,
      dispatchGraceMs: 45_000,
    },
  }),
}));

const describeTaskQueue = jest.fn();
jest.mock('@temporalio/client', () => ({
  Connection: {
    connect: jest.fn().mockResolvedValue({
      workflowService: {
        describeTaskQueue: (req: any) => describeTaskQueue(req),
      },
      close: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// WORKFLOW = 1, ACTIVITY = 2 (temporal.api.enums.v1.TaskQueueType).
const pollersFor = (workflow: number, activity: number) => (req: any) =>
  Promise.resolve({
    pollers: new Array(req.taskQueueType === 1 ? workflow : activity).fill({}),
  });

describe('JourneyExecutionPollerService (EVO-1764)', () => {
  let poller: JourneyExecutionPollerService;
  let metrics: { setTemporalTaskQueueMetrics: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));
    describeTaskQueue.mockReset();
    metrics = { setTemporalTaskQueueMetrics: jest.fn() };
    poller = new JourneyExecutionPollerService(metrics as any);
    // Simulate a journey-worker process where the background poller is active;
    // the hot-path isQueueUnexecutable() short-circuits to no-op without this.
    (poller as any).monitoring = true;
    jest
      .spyOn((poller as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((poller as any).logger, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.useRealTimers());

  it('pollers present → healthy, zeroSince null, gauges set with 0 zero-seconds', async () => {
    describeTaskQueue.mockImplementation(pollersFor(2, 3));
    await (poller as any).poll();

    const s = poller.getStatus();
    expect(s.workflowPollers).toBe(2);
    expect(s.activityPollers).toBe(3);
    expect(s.zeroSince).toBeNull();
    expect(s.healthy).toBe(true);
    expect(metrics.setTemporalTaskQueueMetrics).toHaveBeenCalledWith(
      'journey-execution',
      2,
      3,
      0,
    );
  });

  it('zero WORKFLOW pollers stays healthy within the threshold, flips down once sustained', async () => {
    describeTaskQueue.mockImplementation(pollersFor(0, 1));
    await (poller as any).poll();

    // Just became zero — not yet sustained.
    expect(poller.getStatus().healthy).toBe(true);
    expect(poller.getStatus().zeroSince).not.toBeNull();

    // Advance past zeroPollerSustainedMs (60s).
    jest.setSystemTime(new Date('2026-06-23T00:01:01.000Z'));
    const s = poller.getStatus();
    expect(s.sustainedZeroMs).toBeGreaterThanOrEqual(60_000);
    expect(s.healthy).toBe(false);
  });

  it('recovery resets the sustained-zero clock', async () => {
    describeTaskQueue.mockImplementation(pollersFor(0, 0));
    await (poller as any).poll();
    expect(poller.getStatus().zeroSince).not.toBeNull();

    describeTaskQueue.mockImplementation(pollersFor(1, 1));
    await (poller as any).poll();
    expect(poller.getStatus().zeroSince).toBeNull();
    expect(poller.getStatus().healthy).toBe(true);
  });

  it('F7: a failed poll is stale (held), not reported as zero pollers / down', async () => {
    // First a healthy poll, then Temporal goes unreachable.
    describeTaskQueue.mockImplementation(pollersFor(1, 1));
    await (poller as any).poll();
    describeTaskQueue.mockRejectedValue(new Error('UNAVAILABLE'));
    await (poller as any).poll();

    const s = poller.getStatus();
    expect(s.stale).toBe(true);
    // Stale ≠ down: a Temporal outage must not flip readiness or fire the guard.
    expect(s.healthy).toBe(true);
    expect(s.zeroSince).toBeNull();
  });

  it('EVO-1859: tracks how long Temporal has been unreachable (staleSince/staleSustainedMs)', async () => {
    // A streak of failed polls starts the unreachable clock and keeps it running.
    describeTaskQueue.mockRejectedValue(new Error('UNAVAILABLE'));
    await (poller as any).poll();
    expect(poller.getStatus().staleSince).not.toBeNull();

    const staleSinceFirst = poller.getStatus().staleSince;
    jest.setSystemTime(new Date('2026-06-23T00:01:01.000Z'));
    await (poller as any).poll(); // still failing
    const s = poller.getStatus();
    expect(s.stale).toBe(true);
    expect(s.staleSustainedMs).toBeGreaterThanOrEqual(60_000);
    // The clock anchors to the FIRST failure of the streak, not each poll.
    expect(s.staleSince).toEqual(staleSinceFirst);
  });

  it('EVO-1859: recovery resets the unreachable clock', async () => {
    describeTaskQueue.mockRejectedValue(new Error('UNAVAILABLE'));
    await (poller as any).poll();
    expect(poller.getStatus().staleSince).not.toBeNull();

    describeTaskQueue.mockImplementation(pollersFor(1, 1));
    await (poller as any).poll();
    const s = poller.getStatus();
    expect(s.stale).toBe(false);
    expect(s.staleSince).toBeNull();
    expect(s.staleSustainedMs).toBe(0);
  });

  it('isQueueUnexecutable: true only on a fresh, confirmed, sustained zero', async () => {
    // Sustained zero for >= dispatchGraceMs (45s).
    describeTaskQueue.mockImplementation(pollersFor(0, 0));
    await (poller as any).poll();
    jest.setSystemTime(new Date('2026-06-23T00:00:46.000Z'));

    const verdict = await poller.isQueueUnexecutable();
    expect(verdict.unexecutable).toBe(true);
  });

  it('isQueueUnexecutable: false when stale (Temporal unreachable)', async () => {
    describeTaskQueue.mockRejectedValue(new Error('UNAVAILABLE'));
    const verdict = await poller.isQueueUnexecutable();
    expect(verdict.unexecutable).toBe(false);
    expect(verdict.status.stale).toBe(true);
  });

  it('hot path is a no-op (no RPC) when not monitoring', async () => {
    (poller as any).monitoring = false;
    const verdict = await poller.isQueueUnexecutable();
    expect(verdict.unexecutable).toBe(false);
    expect(describeTaskQueue).not.toHaveBeenCalled();
  });

  it('hot path skips the confirmatory RPC when cached pollers are present', async () => {
    describeTaskQueue.mockImplementation(pollersFor(1, 1));
    await (poller as any).poll(); // background poller saw a healthy worker
    describeTaskQueue.mockClear();
    const verdict = await poller.isQueueUnexecutable();
    expect(verdict.unexecutable).toBe(false);
    expect(describeTaskQueue).not.toHaveBeenCalled(); // no live re-poll
  });

  it('forceLive (manual path): confirmed live zero is unexecutable without the sustained window', async () => {
    describeTaskQueue.mockImplementation(pollersFor(0, 0));
    // Not monitoring, no accumulated sustained window — forceLive still fails it.
    (poller as any).monitoring = false;
    const verdict = await poller.isQueueUnexecutable({ forceLive: true });
    expect(verdict.unexecutable).toBe(true);
    expect(describeTaskQueue).toHaveBeenCalled();
  });

  it('forceLive: pollers present → executable', async () => {
    describeTaskQueue.mockImplementation(pollersFor(1, 0));
    const verdict = await poller.isQueueUnexecutable({ forceLive: true });
    expect(verdict.unexecutable).toBe(false);
  });
});
