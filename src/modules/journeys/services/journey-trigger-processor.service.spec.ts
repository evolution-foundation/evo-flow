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

// The constructor kicks off initializeSingletonCacheService as fire-and-forget.
// Stubbing it keeps construction synchronous and I/O-free, so a test can install
// its own cache mock without first waiting a tick for the real one to land.
const createProcessor = (
  journeysService: any = {},
): JourneyTriggerProcessor => {
  jest
    .spyOn(
      JourneyTriggerProcessor.prototype as any,
      'initializeSingletonCacheService',
    )
    .mockResolvedValue(undefined);

  const processor = new JourneyTriggerProcessor(
    journeysService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  ['log', 'warn', 'error', 'debug'].forEach((method) =>
    jest
      .spyOn((processor as any).logger, method)
      .mockImplementation(() => undefined),
  );

  return processor;
};

describe('JourneyTriggerProcessor.checkForActiveOrWaitingSessions (EVO-1691)', () => {
  let processor: JourneyTriggerProcessor;
  let getSessionsByContact: jest.Mock;

  beforeEach(async () => {
    processor = createProcessor();
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
    processor = createProcessor();

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
    processor = createProcessor();

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
  let warmActiveJourneysCache: jest.Mock;

  beforeEach(async () => {
    warmActiveJourneysCache = jest.fn().mockResolvedValue(0);
    processor = createProcessor({ warmActiveJourneysCache });

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

  // EVO-1927: warm the active-journey cache from the DB before consuming so a
  // post-restart event matches against the real journey set, not an empty cache.
  it('warms the active-journey cache BEFORE subscribing to journey-triggers (EVO-1927)', async () => {
    jest.spyOn(AppFactory, 'shouldStartJourneyWorker').mockReturnValue(true);

    const callOrder: string[] = [];
    warmActiveJourneysCache.mockImplementation(async () => {
      callOrder.push('warm');
      return 3;
    });
    initializeKafkaConsumer.mockImplementation(async () => {
      callOrder.push('init');
    });
    startConsuming.mockImplementation(async () => {
      callOrder.push('consume');
    });

    await processor.onModuleInit();

    expect(warmActiveJourneysCache).toHaveBeenCalledTimes(1);
    // Warm-up must run before the consumer is wired up and starts.
    expect(callOrder).toEqual(['warm', 'init', 'consume']);
  });

  it('still starts consuming when the warm-up fails — read-through fallback covers it (EVO-1927)', async () => {
    jest.spyOn(AppFactory, 'shouldStartJourneyWorker').mockReturnValue(true);
    warmActiveJourneysCache.mockRejectedValue(new Error('db down at boot'));

    await processor.onModuleInit();

    expect(initializeKafkaConsumer).toHaveBeenCalledTimes(1);
    expect(startConsuming).toHaveBeenCalledTimes(1);
  });

  it('does NOT warm the cache in a non-journey-worker mode', async () => {
    jest.spyOn(AppFactory, 'shouldStartJourneyWorker').mockReturnValue(false);

    await processor.onModuleInit();

    expect(warmActiveJourneysCache).not.toHaveBeenCalled();
  });
});

describe('JourneyTriggerProcessor contact-less events', () => {
  let processor: JourneyTriggerProcessor;
  let findActive: jest.Mock;
  let checkWaitingSessions: jest.Mock;
  let triggerJourneyExecution: jest.Mock;

  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      messageId: 'm-1',
      contactId: 'contact-1',
      eventName: 'webhook.sendgrid',
      eventType: 'track',
      properties: '{}',
      traits: '{}',
      timestamp: '2026-08-23T00:00:00.000Z',
      ...overrides,
    }) as any;

  const analyze = (overrides: Record<string, unknown> = {}) =>
    (processor as any).analyzeEventForJourneyTriggers(event(overrides));

  // Same entry point the Kafka consumer uses, so the guard is exercised where it
  // actually sits rather than by reaching into the private method.
  const consume = (overrides: Record<string, unknown> = {}) =>
    (processor as any).processMessage({
      topic: 'journey-triggers',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(event(overrides))) },
    });

  beforeEach(() => {
    findActive = jest.fn().mockResolvedValue([{ id: 'journey-1', name: 'J1' }]);
    processor = createProcessor({ findActive });

    checkWaitingSessions = jest.fn().mockResolvedValue(undefined);
    triggerJourneyExecution = jest.fn().mockResolvedValue(undefined);
    (processor as any).checkWaitingSessions = checkWaitingSessions;
    (processor as any).triggerJourneyExecution = triggerJourneyExecution;
    (processor as any).matchesJourneyTrigger = jest
      .fn()
      .mockResolvedValue(true);
  });

  const expectSkipped = () => {
    expect(triggerJourneyExecution).not.toHaveBeenCalled();
    expect(checkWaitingSessions).not.toHaveBeenCalled();
    expect(findActive).not.toHaveBeenCalled();
  };

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['absent', undefined],
  ])('does not dispatch a workflow when contactId is %s', async (_, id) => {
    await analyze({ contactId: id });

    expectSkipped();
  });

  // No handler can match a nameless event: all eight compare eventName against a
  // concrete string, so letting one through only buys a full session-cache scan.
  it.each([
    ['empty', ''],
    ['whitespace only', '  '],
    ['absent', undefined],
  ])('does not dispatch a workflow when eventName is %s', async (_, name) => {
    await analyze({ eventName: name });

    expectSkipped();
  });

  it('skips before any lookup when the event arrives from the topic', async () => {
    await consume({ contactId: '' });

    expectSkipped();
  });

  // CustomLoggerService.debug is a no-op, so a skip logged there reaches no
  // console and no file: it has to go out at a level that actually prints.
  it('logs the skip where it is actually visible, not at warn', async () => {
    await analyze({ contactId: '' });

    expect((processor as any).logger.log).toHaveBeenCalledWith(
      expect.stringContaining('webhook.sendgrid — no contactId'),
      expect.objectContaining({ messageId: 'm-1' }),
    );
    expect((processor as any).logger.debug).not.toHaveBeenCalled();
    expect((processor as any).logger.warn).not.toHaveBeenCalled();
  });

  it('names a nameless event instead of printing undefined', async () => {
    await analyze({ eventName: '' });

    expect((processor as any).logger.log).toHaveBeenCalledWith(
      expect.stringContaining('<unnamed> — no eventName'),
      expect.anything(),
    );
  });

  // The guard sits ahead of it, so a skipped event must not announce an
  // analysis that never runs.
  it('skips before announcing the analysis', async () => {
    await analyze({ contactId: '' });

    expect((processor as any).logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Analyzing event for journey triggers'),
    );
  });

  it('reports a running total so the volume stays visible', async () => {
    for (let i = 0; i < 1000; i++) {
      await analyze({ contactId: '' });
    }

    expect((processor as any).logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1000 events skipped so far'),
    );
  });

  // Below the interval the total never printed, so a restart used to drop it.
  it('flushes the pending total on shutdown', async () => {
    await analyze({ contactId: '' });

    await (processor as any).onModuleDestroy();

    expect((processor as any).logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1 events skipped so far'),
    );
  });

  it('stays quiet on shutdown when nothing was skipped', async () => {
    await (processor as any).onModuleDestroy();

    expect((processor as any).logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('events skipped so far'),
    );
  });

  it('still dispatches for an event that carries a contact', async () => {
    await analyze();

    expect(checkWaitingSessions).toHaveBeenCalledTimes(1);
    expect(triggerJourneyExecution).toHaveBeenCalledTimes(1);
  });

  it('still dispatches an event consumed from the topic', async () => {
    await consume();

    expect(triggerJourneyExecution).toHaveBeenCalledTimes(1);
  });
});

describe('JourneyTriggerProcessor dispatch guard for contact-less events', () => {
  let processor: JourneyTriggerProcessor;
  let checkForActiveOrWaitingSessions: jest.Mock;
  let getTemporalClient: jest.Mock;

  const journey = { id: 'journey-1', name: 'J1' };

  const dispatch = (contactId?: string) =>
    (processor as any).triggerJourneyExecution(
      {
        messageId: 'm-1',
        contactId,
        eventName: 'evt',
        eventType: 'track',
        properties: '{}',
        timestamp: '2026-08-23T00:00:00.000Z',
      },
      journey,
    );

  beforeEach(() => {
    processor = createProcessor();
    checkForActiveOrWaitingSessions = jest.fn().mockResolvedValue(false);
    getTemporalClient = jest.fn();
    (processor as any).checkForActiveOrWaitingSessions =
      checkForActiveOrWaitingSessions;
    (processor as any).getTemporalClient = getTemporalClient;
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  '],
    ['absent', undefined],
  ])('refuses to dispatch when contactId is %s', async (_, contactId) => {
    await dispatch(contactId);

    expect(checkForActiveOrWaitingSessions).not.toHaveBeenCalled();
    expect(getTemporalClient).not.toHaveBeenCalled();
  });

  it('logs at error — getting here means the intake guard was bypassed', async () => {
    await dispatch('');

    expect((processor as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('intake guard was bypassed'),
      expect.objectContaining({ journeyId: 'journey-1' }),
    );
  });
});
