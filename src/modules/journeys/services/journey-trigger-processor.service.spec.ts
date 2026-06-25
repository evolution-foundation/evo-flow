import { JourneyTriggerProcessor } from './journey-trigger-processor.service';
import { JourneySessionStatus } from '../entities/journey-session.entity';
import { AppFactory } from '../../../app-factory';

// The constructor spins up a real (Redis-backed) JourneySessionCacheService via
// initializeSingletonCacheService; mock the module so construction stays I/O-free.
jest.mock('../../cache/services/journey-session-cache.service');
// triggerJourneyExecution dynamically imports the workflow definition; stub it so
// the guard test does not load the heavy Temporal workflow graph.
jest.mock(
  '../../temporal/workflows/journey-execution.workflow',
  () => ({ JourneyExecutionWorkflow: jest.fn() }),
  { virtual: true },
);

describe('JourneyTriggerProcessor.checkForActiveOrWaitingSessions (EVO-1691)', () => {
  let processor: JourneyTriggerProcessor;
  let getSessionsByContact: jest.Mock;

  beforeEach(async () => {
    processor = new JourneyTriggerProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn((processor as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((processor as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((processor as any).logger, 'error')
      .mockImplementation(() => undefined);

    // Let the fire-and-forget initializeSingletonCacheService settle, then swap
    // in a controllable cache mock.
    await new Promise((resolve) => setImmediate(resolve));
    getSessionsByContact = jest.fn();
    (processor as any).sessionCacheService = { getSessionsByContact };
  });

  const check = (journeyId?: string): Promise<boolean> =>
    (processor as any).checkForActiveOrWaitingSessions('contact-1', journeyId);

  it('blocks when the contact has an active session for the SAME journey', async () => {
    getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.ACTIVE, journeyId: 'journey-1' },
    ]);
    await expect(check('journey-1')).resolves.toBe(true);
  });

  it('allows when the active session belongs to a DIFFERENT journey (EVO-1691)', async () => {
    getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.ACTIVE, journeyId: 'journey-2' },
    ]);
    await expect(check('journey-1')).resolves.toBe(false);
  });

  it('allows when the contact has no active/waiting session for the journey', async () => {
    getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.COMPLETED, journeyId: 'journey-1' },
    ]);
    await expect(check('journey-1')).resolves.toBe(false);
  });

  it('does not block (returns false) when the session cache errors', async () => {
    getSessionsByContact.mockRejectedValue(new Error('redis down'));
    await expect(check('journey-1')).resolves.toBe(false);
  });
});

describe('JourneyTriggerProcessor dispatch fail-fast guard (EVO-1764)', () => {
  let processor: JourneyTriggerProcessor;
  let handle: { firstExecutionRunId: string; terminate: jest.Mock };
  let isQueueUnexecutable: jest.Mock;
  let createFailedDispatchSession: jest.Mock;
  let updateSessionStatus: jest.Mock;

  const event = {
    messageId: 'm-1',
    contactId: 'contact-1',
    eventName: 'evt',
    eventType: 'track',
    properties: '{}',
    traits: '{}',
    timestamp: '2026-06-23T00:00:00.000Z',
  };
  const journey = { id: 'journey-1', name: 'J1' };

  const trigger = () =>
    (processor as any).triggerJourneyExecution(event, journey);

  beforeEach(async () => {
    processor = new JourneyTriggerProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    ['log', 'warn', 'error'].forEach((m) =>
      jest
        .spyOn((processor as any).logger, m)
        .mockImplementation(() => undefined),
    );
    await new Promise((resolve) => setImmediate(resolve));

    handle = {
      firstExecutionRunId: 'run-1',
      terminate: jest.fn().mockResolvedValue(undefined),
    };
    isQueueUnexecutable = jest.fn();
    createFailedDispatchSession = jest.fn();
    updateSessionStatus = jest.fn();

    // No pre-existing session, controllable client + poller + cache.
    (processor as any).checkForActiveOrWaitingSessions = jest
      .fn()
      .mockResolvedValue(false);
    (processor as any).getTemporalClient = jest.fn().mockResolvedValue({
      workflow: { start: jest.fn().mockResolvedValue(handle) },
    });
    (processor as any).queueHealthPoller = { isQueueUnexecutable };
    (processor as any).sessionCacheService = {
      createFailedDispatchSession,
      updateSessionStatus,
      // EVO-1896: dedup guard claims the messageId before dispatch; first call wins.
      tryClaimTriggerMessage: jest.fn().mockResolvedValue(true),
    };
  });

  it('AC5: sustained-zero pollers → terminate + session failed, no "active"', async () => {
    isQueueUnexecutable.mockResolvedValue({
      unexecutable: true,
      status: { sustainedZeroMs: 90_000 },
    });

    await trigger();

    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(createFailedDispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        journeyId: 'journey-1',
        contactId: 'contact-1',
        workflowRunId: 'run-1',
        errorMessage: expect.stringContaining('no journey-execution worker'),
      }),
    );
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('AC6: pollers present → normal dispatch, session active, no terminate', async () => {
    isQueueUnexecutable.mockResolvedValue({
      unexecutable: false,
      status: { sustainedZeroMs: 0 },
    });

    await trigger();

    expect(handle.terminate).not.toHaveBeenCalled();
    expect(createFailedDispatchSession).not.toHaveBeenCalled();
    expect(updateSessionStatus).toHaveBeenCalledWith(
      expect.any(String),
      'active',
      expect.objectContaining({ workflowRunId: 'run-1' }),
    );
  });

  it('F5: a transient blip that recovers (unexecutable=false) is not terminated', async () => {
    // isQueueUnexecutable already does a fresh live poll internally; if the
    // worker returned during the grace window it reports executable.
    isQueueUnexecutable.mockResolvedValue({
      unexecutable: false,
      status: { sustainedZeroMs: 12_000, stale: false },
    });

    await trigger();

    expect(handle.terminate).not.toHaveBeenCalled();
    expect(updateSessionStatus).toHaveBeenCalled();
  });
});

describe('JourneyTriggerProcessor messageId idempotency (EVO-1896)', () => {
  let processor: JourneyTriggerProcessor;
  let tryClaimTriggerMessage: jest.Mock;
  let workflowStart: jest.Mock;
  let updateSessionStatus: jest.Mock;

  const baseEvent = {
    messageId: 'msg-dup-1',
    contactId: 'contact-1',
    eventName: 'evt',
    eventType: 'track',
    properties: '{}',
    traits: '{}',
    timestamp: '2026-06-24T00:00:00.000Z',
  };
  const journey = { id: 'journey-1', name: 'J1' };

  const trigger = (event: any = baseEvent) =>
    (processor as any).triggerJourneyExecution(event, journey);

  beforeEach(async () => {
    processor = new JourneyTriggerProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    ['log', 'warn', 'error'].forEach((m) =>
      jest
        .spyOn((processor as any).logger, m)
        .mockImplementation(() => undefined),
    );
    await new Promise((resolve) => setImmediate(resolve));

    workflowStart = jest.fn().mockResolvedValue({
      firstExecutionRunId: 'run-1',
      terminate: jest.fn().mockResolvedValue(undefined),
    });
    updateSessionStatus = jest.fn();
    tryClaimTriggerMessage = jest.fn();

    (processor as any).checkForActiveOrWaitingSessions = jest
      .fn()
      .mockResolvedValue(false);
    (processor as any).getTemporalClient = jest.fn().mockResolvedValue({
      workflow: { start: workflowStart },
    });
    (processor as any).queueHealthPoller = {
      isQueueUnexecutable: jest
        .fn()
        .mockResolvedValue({ unexecutable: false, status: {} }),
    };
    (processor as any).sessionCacheService = {
      createFailedDispatchSession: jest.fn(),
      updateSessionStatus,
      tryClaimTriggerMessage,
    };
  });

  it('starts the workflow when the messageId is claimed (first delivery)', async () => {
    tryClaimTriggerMessage.mockResolvedValue(true);

    await trigger();

    expect(tryClaimTriggerMessage).toHaveBeenCalledWith(
      'journey-1',
      'contact-1',
      'msg-dup-1',
    );
    expect(workflowStart).toHaveBeenCalledTimes(1);
    expect(updateSessionStatus).toHaveBeenCalled();
  });

  it('skips the workflow on a redelivered messageId (claim refused)', async () => {
    tryClaimTriggerMessage.mockResolvedValue(false);

    await trigger();

    expect(tryClaimTriggerMessage).toHaveBeenCalledTimes(1);
    expect(workflowStart).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('does not dedup when the event has no messageId (proceeds)', async () => {
    const noId = { ...baseEvent, messageId: undefined };

    await trigger(noId);

    expect(tryClaimTriggerMessage).not.toHaveBeenCalled();
    expect(workflowStart).toHaveBeenCalledTimes(1);
  });
});

describe('JourneyTriggerProcessor consumer gating (EVO-1764 A1)', () => {
  let processor: JourneyTriggerProcessor;
  let initializeKafkaConsumer: jest.Mock;
  let startConsuming: jest.Mock;

  beforeEach(async () => {
    processor = new JourneyTriggerProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    ['log', 'warn', 'error'].forEach((m) =>
      jest
        .spyOn((processor as any).logger, m)
        .mockImplementation(() => undefined),
    );
    await new Promise((resolve) => setImmediate(resolve));

    initializeKafkaConsumer = jest.fn().mockResolvedValue(undefined);
    startConsuming = jest.fn().mockResolvedValue(undefined);
    (processor as any).initializeKafkaConsumer = initializeKafkaConsumer;
    (processor as any).startConsuming = startConsuming;
  });

  afterEach(() => jest.restoreAllMocks());

  it('starts the journey-triggers consumer in a journey-worker mode', async () => {
    jest.spyOn(AppFactory, 'shouldStartJourneyWorker').mockReturnValue(true);

    await processor.onModuleInit();

    expect(initializeKafkaConsumer).toHaveBeenCalledTimes(1);
    expect(startConsuming).toHaveBeenCalledTimes(1);
  });

  it('does NOT consume journey-triggers in a non-journey-worker mode (e.g. CAMPAIGN_WORKER) — the fail-fast guard poller is off there, so consuming would dispatch guard-less', async () => {
    // CAMPAIGN_WORKER is in shouldStartTemporalWorker() (TemporalModule import)
    // but NOT shouldStartJourneyWorker() — the gate the consumer must honor.
    jest.spyOn(AppFactory, 'shouldStartJourneyWorker').mockReturnValue(false);

    await processor.onModuleInit();

    expect(initializeKafkaConsumer).not.toHaveBeenCalled();
    expect(startConsuming).not.toHaveBeenCalled();
  });
});
