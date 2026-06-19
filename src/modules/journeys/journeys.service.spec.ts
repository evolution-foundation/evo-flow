import { JourneysService } from './journeys.service';
import { BadRequestException } from '@nestjs/common';

describe('JourneysService.processSpecificJourneyWebhookTrigger', () => {
  let service: JourneysService;
  let startJourney: jest.Mock;

  const activeJourney = { id: 'journey-1', name: 'J1', isActive: true };

  beforeEach(() => {
    startJourney = jest
      .fn()
      .mockResolvedValue({ started: true, sessionId: 's1', workflowId: 'wf1' });
    service = new JourneysService(
      {} as any,
      {} as any,
      { startJourney } as any,
    );
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  it('starts the named journey with data merged into the properties top level', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue(activeJourney as any);

    const res = await service.processSpecificJourneyWebhookTrigger(
      'journey-1',
      {
        contact_id: 'contact-1',
        data: { conversation_id: 'conv-1' },
      },
    );

    expect(res.success).toBe(true);
    expect(startJourney).toHaveBeenCalledTimes(1);
    const [journeyArg, contactArg, triggerEvent] = startJourney.mock.calls[0];
    expect(journeyArg.id).toBe('journey-1');
    expect(contactArg).toBe('contact-1');
    expect(triggerEvent.properties.conversation_id).toBe('conv-1');
    expect(triggerEvent.eventName).toBe('webhook.journey_trigger');
  });

  it('rejects an inactive journey without starting it', async () => {
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ ...activeJourney, isActive: false } as any);

    await expect(
      service.processSpecificJourneyWebhookTrigger('journey-1', {
        contact_id: 'contact-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(startJourney).not.toHaveBeenCalled();
  });

  it('rejects when the journey could not be started (guard blocked)', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue(activeJourney as any);
    startJourney.mockResolvedValue({
      started: false,
      reason: 'contact_has_active_session',
    });

    await expect(
      service.processSpecificJourneyWebhookTrigger('journey-1', {
        contact_id: 'contact-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires contact_id', async () => {
    await expect(
      service.processSpecificJourneyWebhookTrigger('journey-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(startJourney).not.toHaveBeenCalled();
  });
});

describe('JourneysService.getJourneyVariables — EVO-1836 cache-hit preserves variables', () => {
  it('returns the cached journey variables (findOne must not drop variables on cache hit)', async () => {
    const vars = [
      { id: 'v1', name: 'lead_score', type: 'number', defaultValue: '0' },
    ];
    const journeyCacheService = {
      get: jest.fn().mockResolvedValue({
        id: 'journey-1',
        name: 'J1',
        description: '',
        isActive: true,
        flowData: {},
        flowTriggers: [],
        variables: vars,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    const service = new JourneysService(
      {} as any,
      journeyCacheService as any,
      {} as any,
    );
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    const result = await service.getJourneyVariables('journey-1');

    expect(journeyCacheService.get).toHaveBeenCalledWith('journey-1');
    expect(result).toEqual(vars);
  });
});
