import type { JourneyTrackingContext } from '../services/journey-tracking.service';

// EVO-1894: the tracking activity must initialize a connected Kafka producer in
// the single / temporal-worker process and, when it cannot, degrade silently
// (no per-event ERROR "Kafka producer not initialized" spam). These tests drive
// the createTrackingService() caching/degrade logic through the public
// trackJourneyStarted activity, mocking KafkaService and the temporal logger.

const onModuleInit = jest.fn();
const getStatus = jest.fn();
const sendEvent = jest.fn();

class MockKafkaService {
  onModuleInit = onModuleInit;
  getStatus = getStatus;
  sendEvent = sendEvent;
}

jest.mock('../../processing/kafka/kafka.service', () => ({
  KafkaService: MockKafkaService,
}));

const logInfo = jest.fn();
const logWarn = jest.fn();
const logError = jest.fn();
jest.mock('@temporalio/activity', () => ({
  log: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    error: (...a: unknown[]) => logError(...a),
    debug: jest.fn(),
  },
}));

const CONTEXT: JourneyTrackingContext = {
  sessionId: 'sess-1',
  journeyId: 'journey-1',
  contactId: 'contact-1',
} as JourneyTrackingContext;

describe('journey-tracking activities — Kafka producer init/degrade (EVO-1894)', () => {
  beforeEach(() => {
    jest.resetModules();
    onModuleInit.mockReset().mockResolvedValue(undefined);
    getStatus.mockReset();
    sendEvent.mockReset().mockResolvedValue(undefined);
    logInfo.mockReset();
    logWarn.mockReset();
    logError.mockReset();
  });

  it('initializes the producer and sends a tracking event when Kafka is connected', async () => {
    getStatus.mockResolvedValue({ connected: true });

    const { journeyTrackingActivities } = await import(
      './journey-tracking.activities'
    );
    await journeyTrackingActivities.trackJourneyStarted(CONTEXT, {
      eventName: 'journey.started',
    });

    expect(onModuleInit).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    // No ERROR spam on the happy path.
    expect(logError).not.toHaveBeenCalled();
  });

  it('degrades silently (single warn, no per-event ERROR) when the producer is not connected', async () => {
    // onModuleInit "succeeds" but the producer never connected.
    getStatus.mockResolvedValue({ connected: false });

    const { journeyTrackingActivities } = await import(
      './journey-tracking.activities'
    );

    await journeyTrackingActivities.trackJourneyStarted(CONTEXT);
    await journeyTrackingActivities.trackNodeExecution(CONTEXT, {
      nodeId: 'n1',
      nodeType: 'message',
      status: 'success',
    } as any);

    // Never attempts to send (which would throw "producer not initialized").
    expect(sendEvent).not.toHaveBeenCalled();
    // The degrade warning is emitted exactly once for the process, not per event.
    const degradeWarns = logWarn.mock.calls.filter((c) =>
      String(c[0]).includes('Journey tracking disabled'),
    );
    expect(degradeWarns).toHaveLength(1);
    // No "Failed to send journey tracking event to Kafka" ERROR noise.
    const sendErrors = logError.mock.calls.filter((c) =>
      String(c[0]).includes('Failed to send journey tracking event to Kafka'),
    );
    expect(sendErrors).toHaveLength(0);
  });

  it('does not cache a producer-less KafkaService when init throws', async () => {
    onModuleInit.mockRejectedValue(new Error('broker down'));

    const { journeyTrackingActivities } = await import(
      './journey-tracking.activities'
    );

    await journeyTrackingActivities.trackJourneyStarted(CONTEXT);
    await journeyTrackingActivities.trackJourneyStarted(CONTEXT);

    // sendEvent is never called against an uninitialized producer.
    expect(sendEvent).not.toHaveBeenCalled();
    // Degrade warning is emitted once, not on every call.
    const degradeWarns = logWarn.mock.calls.filter((c) =>
      String(c[0]).includes('Journey tracking disabled'),
    );
    expect(degradeWarns).toHaveLength(1);
  });
});
