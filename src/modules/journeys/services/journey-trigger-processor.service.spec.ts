import { JourneyTriggerProcessor } from './journey-trigger-processor.service';
import { JourneySessionStatus } from '../entities/journey-session.entity';

// The constructor spins up a real (Redis-backed) JourneySessionCacheService via
// initializeSingletonCacheService; mock the module so construction stays I/O-free.
jest.mock('../../cache/services/journey-session-cache.service');

describe('JourneyTriggerProcessor.checkForActiveOrWaitingSessions (EVO-1691)', () => {
  let processor: JourneyTriggerProcessor;
  let getSessionsByContact: jest.Mock;

  beforeEach(async () => {
    processor = new JourneyTriggerProcessor(
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
