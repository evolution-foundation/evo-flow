import { JourneySessionsService } from './journey-sessions.service';
import { JourneySessionStatus } from '../entities/journey-session.entity';

jest.mock('../../temporal/workflows/journey-execution.workflow', () => ({
  JourneyExecutionWorkflow: jest.fn(),
}));

describe('JourneySessionsService.startJourney', () => {
  let service: JourneySessionsService;
  let cache: {
    getSessionsByContact: jest.Mock;
    set: jest.Mock;
    updateSessionStatus: jest.Mock;
    invalidate: jest.Mock;
  };
  let poller: { isQueueUnexecutable: jest.Mock };
  let workflowStart: jest.Mock;

  const journey = { id: 'journey-1', name: 'J1' };
  const contactId = 'contact-1';
  const triggerEvent = {
    messageId: 'm1',
    eventName: 'webhook.journey_trigger',
    eventType: 'track',
    properties: { conversation_id: 'conv-1' },
    timestamp: '2026-06-05T00:00:00.000Z',
  };

  beforeEach(() => {
    cache = {
      getSessionsByContact: jest.fn().mockResolvedValue([]),
      set: jest.fn().mockResolvedValue(undefined),
      updateSessionStatus: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    // Default: a healthy queue so the existing happy-path assertions hold.
    poller = {
      isQueueUnexecutable: jest
        .fn()
        .mockResolvedValue({ unexecutable: false, status: {} }),
    };
    service = new JourneySessionsService(cache as any, poller as any);
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    workflowStart = jest
      .fn()
      .mockResolvedValue({ firstExecutionRunId: 'run-1', terminate: jest.fn() });
    jest
      .spyOn(service as any, 'getTemporalClient')
      .mockResolvedValue({ workflow: { start: workflowStart } });
  });

  it('creates the session before starting the workflow and returns started', async () => {
    const result = await service.startJourney(journey, contactId, triggerEvent);

    expect(result.started).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.workflowId).toContain('journey-journey-1-contact-contact-1');

    expect(cache.set).toHaveBeenCalledTimes(1);
    const persisted = cache.set.mock.calls[0][0];
    expect(persisted.journeyId).toBe('journey-1');
    expect(persisted.contactId).toBe('contact-1');
    expect(persisted.status).toBe(JourneySessionStatus.ACTIVE);

    expect(workflowStart).toHaveBeenCalledTimes(1);
    const startOpts = workflowStart.mock.calls[0][1];
    expect(startOpts.taskQueue).toBe('journey-execution');
    expect(startOpts.args[0].sessionId).toBe(result.sessionId);
    expect(startOpts.args[0].triggerEvent.properties.conversation_id).toBe(
      'conv-1',
    );

    // The session must exist before the workflow starts: the workflow's first
    // updateJourneySession throws if the session is missing.
    expect(cache.set.mock.invocationCallOrder[0]).toBeLessThan(
      workflowStart.mock.invocationCallOrder[0],
    );

    expect(cache.updateSessionStatus).toHaveBeenCalledWith(
      result.sessionId,
      JourneySessionStatus.ACTIVE,
      expect.objectContaining({
        workflowId: result.workflowId,
        workflowRunId: 'run-1',
      }),
      // EVO-1892: best-effort so a FK persistence failure cannot undo the start.
      { bestEffortPersist: true },
    );
  });

  it('blocks when the contact already has an active session for the same journey', async () => {
    cache.getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.ACTIVE, journeyId: 'journey-1' },
    ]);

    const result = await service.startJourney(journey, contactId, triggerEvent);

    expect(result.started).toBe(false);
    expect(result.reason).toBe('contact_has_active_session');
    expect(cache.set).not.toHaveBeenCalled();
    expect(workflowStart).not.toHaveBeenCalled();
  });

  it('allows the journey when the active session belongs to a different journey (EVO-1691)', async () => {
    cache.getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.ACTIVE, journeyId: 'other-journey' },
    ]);

    const result = await service.startJourney(journey, contactId, triggerEvent);

    expect(result.started).toBe(true);
    expect(workflowStart).toHaveBeenCalledTimes(1);
  });

  it('bypasses the active-session guard when enforceActiveSessionGuard is false', async () => {
    cache.getSessionsByContact.mockResolvedValue([
      { status: JourneySessionStatus.ACTIVE },
    ]);

    const result = await service.startJourney(
      journey,
      contactId,
      triggerEvent,
      {
        enforceActiveSessionGuard: false,
      },
    );

    expect(result.started).toBe(true);
    expect(cache.getSessionsByContact).not.toHaveBeenCalled();
    expect(workflowStart).toHaveBeenCalledTimes(1);
  });

  it('EVO-1764: fails fast when journey-execution has no worker (forceLive)', async () => {
    const handle = {
      firstExecutionRunId: 'run-1',
      terminate: jest.fn().mockResolvedValue(undefined),
    };
    workflowStart.mockResolvedValue(handle);
    poller.isQueueUnexecutable.mockResolvedValue({
      unexecutable: true,
      status: { sustainedZeroMs: 0 },
    });

    const result = await service.startJourney(journey, contactId, triggerEvent);

    // Manual path forces a live check (its process may not run the poller).
    expect(poller.isQueueUnexecutable).toHaveBeenCalledWith({ forceLive: true });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('no_worker_available');
    // The just-started workflow is terminated and the pre-created ACTIVE row is
    // flipped to FAILED so it no longer blocks future triggers.
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(cache.updateSessionStatus).toHaveBeenCalledWith(
      result.sessionId,
      JourneySessionStatus.FAILED,
      expect.objectContaining({
        errorMessage: expect.stringContaining('no journey-execution worker'),
      }),
      // EVO-1892: best-effort (the row may not exist in Postgres after a
      // FK-failed best-effort create).
      { bestEffortPersist: true },
    );
    // Not marked ACTIVE.
    expect(cache.updateSessionStatus).not.toHaveBeenCalledWith(
      result.sessionId,
      JourneySessionStatus.ACTIVE,
      expect.anything(),
      expect.anything(),
    );
  });

  it('EVO-1892: creates the session best-effort so a FK persistence failure cannot abort the start', async () => {
    const result = await service.startJourney(journey, contactId, triggerEvent);

    expect(result.started).toBe(true);
    // The create must opt into best-effort persistence: the contact is absent
    // from evo_campaign.contacts, so the Postgres write FK-fails; swallowing it
    // (cache-first) is what lets the workflow start instead of aborting.
    expect(cache.set).toHaveBeenCalledWith(
      expect.objectContaining({
        journeyId: 'journey-1',
        contactId: 'contact-1',
        status: JourneySessionStatus.ACTIVE,
      }),
      { bestEffortPersist: true },
    );
    // The post-start ACTIVE status write is best-effort too — the row may not be
    // in Postgres, and a FK failure there must not undo a started workflow.
    expect(cache.updateSessionStatus).toHaveBeenCalledWith(
      result.sessionId,
      JourneySessionStatus.ACTIVE,
      expect.objectContaining({ workflowId: result.workflowId }),
      { bestEffortPersist: true },
    );
    expect(workflowStart).toHaveBeenCalledTimes(1);
  });

  it('EVO-1892: start still succeeds (no orphan) when persistence rejects but the cache holds the session', async () => {
    // Simulate the real failure shape: the cache write-through to Postgres
    // FK-fails, but because the start path persists best-effort the cache layer
    // resolves rather than throwing. The session lives in the cache and the
    // workflow starts — it is never orphaned/ABORTed.
    const result = await service.startJourney(journey, contactId, triggerEvent);

    expect(result.started).toBe(true);
    expect(result.sessionId).toBeDefined();
    // No rollback/invalidate happened: a successful start must keep the session.
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('rolls back the created session when the workflow fails to start', async () => {
    workflowStart.mockRejectedValue(new Error('temporal down'));

    await expect(
      service.startJourney(journey, contactId, triggerEvent),
    ).rejects.toThrow('temporal down');

    // The session was created, then invalidated so it cannot phantom-block
    // future triggers for this contact.
    expect(cache.set).toHaveBeenCalledTimes(1);
    const createdId = cache.set.mock.calls[0][0].id;
    expect(cache.invalidate).toHaveBeenCalledWith(createdId);
    expect(cache.updateSessionStatus).not.toHaveBeenCalled();
  });
});
