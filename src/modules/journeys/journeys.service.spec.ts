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

describe('JourneysService.findActive — EVO-1927 read-through on empty cache', () => {
  const dbJourney = {
    id: 'journey-1',
    name: 'J1',
    description: '',
    isActive: true,
    flowData: {},
    flowTriggers: [{ type: 'event' }],
    variables: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  const buildService = (
    cached: any[],
    dbActive: any[],
  ): {
    service: JourneysService;
    getActiveJourneys: jest.Mock;
    set: jest.Mock;
    find: jest.Mock;
    warn: jest.Mock;
  } => {
    const getActiveJourneys = jest.fn().mockResolvedValue(cached);
    const set = jest.fn().mockResolvedValue(undefined);
    const journeyCacheService = { getActiveJourneys, set };

    const find = jest.fn().mockResolvedValue(dbActive);
    const repo = { find };
    const db = { getRepository: () => repo };

    const service = new JourneysService(
      db as any,
      journeyCacheService as any,
      {} as any,
    );
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined) as unknown as jest.Mock;
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    return { service, getActiveJourneys, set, find, warn };
  };

  it('returns cached active journeys without hitting the DB when the cache is warm', async () => {
    const { service, find } = buildService([dbJourney], []);

    const result = await service.findActive();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('journey-1');
    expect(find).not.toHaveBeenCalled();
  });

  it('falls through to the DB and returns active journeys when the cache is empty (post-restart regression)', async () => {
    const { service, find, set } = buildService([], [dbJourney]);

    const result = await service.findActive();

    expect(find).toHaveBeenCalledWith({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('journey-1');
    // Cache repopulated so the next read is a hit.
    expect(set).toHaveBeenCalledWith(dbJourney);
  });

  it('warns when the cache returns 0 but the DB has active journeys (observability)', async () => {
    const { service, warn } = buildService([], [dbJourney]);

    await service.findActive();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('findActive cache miss'),
    );
  });

  it('returns [] without warning when both cache and DB are empty', async () => {
    const { service, warn, set } = buildService([], []);

    const result = await service.findActive();

    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('still returns DB journeys when repopulating the cache fails (best-effort)', async () => {
    const { service, set } = buildService([], [dbJourney]);
    set.mockRejectedValue(new Error('redis down'));

    const result = await service.findActive();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('journey-1');
  });
});

describe('JourneysService.warmActiveJourneysCache — EVO-1927 boot warm-up', () => {
  const buildService = (
    dbActive: any[],
  ): { service: JourneysService; set: jest.Mock; find: jest.Mock } => {
    const set = jest.fn().mockResolvedValue(undefined);
    const find = jest.fn().mockResolvedValue(dbActive);
    const db = { getRepository: () => ({ find }) };
    const service = new JourneysService(
      db as any,
      { set } as any,
      {} as any,
    );
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    return { service, set, find };
  };

  it('loads active journeys from the DB and populates the cache', async () => {
    const j1 = { id: 'j1', isActive: true };
    const j2 = { id: 'j2', isActive: true };
    const { service, set, find } = buildService([j1, j2]);

    const count = await service.warmActiveJourneysCache();

    expect(find).toHaveBeenCalledWith({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(j1);
    expect(set).toHaveBeenCalledWith(j2);
    expect(count).toBe(2);
  });

  it('does not throw when a per-journey cache write fails', async () => {
    const { service, set } = buildService([{ id: 'j1', isActive: true }]);
    set.mockRejectedValue(new Error('redis down'));

    await expect(service.warmActiveJourneysCache()).resolves.toBe(1);
  });
});
