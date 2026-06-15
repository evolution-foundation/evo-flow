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
    service = new JourneySessionsService(cache as any);
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    workflowStart = jest
      .fn()
      .mockResolvedValue({ firstExecutionRunId: 'run-1' });
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
