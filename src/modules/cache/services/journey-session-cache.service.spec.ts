import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import { JourneySession } from '../../journeys/entities/journey-session.entity';

// Shared fake Redis store: a single map backs every FakeRedis instance, the
// same way one Redis server backs every service replica. This is what lets
// the cross-instance test below prove sessions are NOT in-process-only.
const mockKv = new Map<string, string>();
const mockSets = new Map<string, Set<string>>();

class FakeRedis {
  status = 'ready';
  on(): this {
    return this;
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  quit(): Promise<void> {
    return Promise.resolve();
  }
  get(key: string): Promise<string | null> {
    return Promise.resolve(mockKv.get(key) ?? null);
  }
  setex(key: string, _ttl: number, value: string): Promise<void> {
    mockKv.set(key, value);
    return Promise.resolve();
  }
  // EVO-1896: SET key value EX <ttl> NX → 'OK' when set, null when key exists.
  set(
    key: string,
    value: string,
    ..._opts: unknown[]
  ): Promise<string | null> {
    const isNx = _opts.includes('NX');
    if (isNx && mockKv.has(key)) {
      return Promise.resolve(null);
    }
    mockKv.set(key, value);
    return Promise.resolve('OK');
  }
  mget(keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((k) => mockKv.get(k) ?? null));
  }
  del(...keys: string[]): Promise<void> {
    keys.forEach((k) => {
      mockKv.delete(k);
      mockSets.delete(k);
    });
    return Promise.resolve();
  }
  sadd(key: string, ...members: string[]): Promise<void> {
    const set = mockSets.get(key) ?? new Set<string>();
    members.forEach((m) => set.add(m));
    mockSets.set(key, set);
    return Promise.resolve();
  }
  srem(key: string, ...members: string[]): Promise<void> {
    const set = mockSets.get(key);
    members.forEach((m) => set?.delete(m));
    return Promise.resolve();
  }
  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(mockSets.get(key) ?? [])]);
  }
  expire(): Promise<void> {
    return Promise.resolve();
  }
  pipeline() {
    const ops: Array<() => void> = [];
    const self = {
      setex: (key: string, _ttl: number, value: string) => {
        ops.push(() => mockKv.set(key, value));
        return self;
      },
      exec: (): Promise<unknown[]> => {
        ops.forEach((op) => op());
        return Promise.resolve([]);
      },
    };
    return self;
  }
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: FakeRedis,
}));

jest.mock('./redis-singleton.service', () => ({
  RedisSingleton: { getInstance: () => Promise.resolve(new FakeRedis()) },
}));

import { JourneySessionCacheService } from './journey-session-cache.service';

type MockRepository = jest.Mocked<
  Pick<Repository<JourneySession>, 'findOne' | 'find' | 'save'>
> & { manager: { query: jest.Mock } };

function makeRepository(): MockRepository {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    // EVO-1929: the lazy contact upsert runs through the entity manager.
    manager: { query: jest.fn().mockResolvedValue([]) },
  } as unknown as MockRepository;
}

function makeSession(id: string): JourneySession {
  return {
    id,
    journeyId: 'journey-1',
    contactId: 'contact-1',
    status: 'active',
    currentNodeId: 'n1',
    variables: { foo: 'bar' },
    retryCount: 0,
    maxRetries: 3,
    executionLogs: [],
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  } as unknown as JourneySession;
}

function makeService(repo: ReturnType<typeof makeRepository>) {
  return new JourneySessionCacheService(
    repo as unknown as Repository<JourneySession>,
    new EventEmitter2(),
  );
}

describe('JourneySessionCacheService — shared-layer guarantees (EVO-1645)', () => {
  beforeEach(() => {
    mockKv.clear();
    mockSets.clear();
    jest.clearAllMocks();
  });

  it('shares sessions across service instances via the Redis layer (not in-process)', async () => {
    const repoA = makeRepository();
    const repoB = makeRepository();
    const instanceA = makeService(repoA);
    const instanceB = makeService(repoB);

    await instanceA.set(makeSession('sess-1'));
    const seen = await instanceB.get('sess-1');

    expect(seen?.id).toBe('sess-1');
    expect(seen?.variables).toEqual({ foo: 'bar' });
    // Instance B never touched its database — the session came from the
    // shared layer, proving the cache is not in-process-only.
    expect(repoB.findOne).not.toHaveBeenCalled();
  });

  it('falls back to the database on a Redis miss (external DB seeding path)', async () => {
    const repo = makeRepository();
    repo.findOne.mockResolvedValue(makeSession('sess-db'));
    const service = makeService(repo);

    const seen = await service.get('sess-db');

    expect(seen?.id).toBe('sess-db');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'sess-db' } });
    // The DB-seeded session is re-cached into the shared layer.
    expect(mockKv.has('evo-campaign:journey-session:sess-db')).toBe(true);
  });

  it('getMultiple falls back to the database with a valid TypeORM In() clause', async () => {
    const repo = makeRepository();
    repo.find.mockResolvedValue([makeSession('sess-a'), makeSession('sess-b')]);
    const service = makeService(repo);

    const seen = await service.getMultiple(['sess-a', 'sess-b']);

    expect(repo.find).toHaveBeenCalledWith({
      where: { id: In(['sess-a', 'sess-b']) },
    });
    expect(seen.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
  });
});

describe('JourneySessionCacheService — Postgres write-through durability (EVO-1756)', () => {
  beforeEach(() => {
    mockKv.clear();
    mockSets.clear();
    jest.clearAllMocks();
  });

  it('persists the session to Postgres on set(), not just Redis', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    await service.set(makeSession('sess-1'));

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sess-1',
        journeyId: 'journey-1',
        contactId: 'contact-1',
        status: 'active',
        variables: { foo: 'bar' },
      }),
    );
    // Still written to the shared Redis layer too.
    expect(mockKv.has('evo-campaign:journey-session:sess-1')).toBe(true);
  });

  it('durably persists a terminal (failed) status transition', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    await service.set(makeSession('sess-2'));
    repo.save.mockClear();

    const failedAt = new Date('2026-06-02T00:00:00Z');
    await service.updateSessionStatus('sess-2', 'failed', {
      failedAt,
      errorMessage: 'boom',
    });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sess-2',
        status: 'failed',
        failedAt,
        errorMessage: 'boom',
      }),
    );
  });

  it('propagates a Postgres write failure (durability is not best-effort)', async () => {
    const repo = makeRepository();
    repo.save.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(repo);

    await expect(service.set(makeSession('sess-3'))).rejects.toThrow('db down');
  });
});

describe('JourneySessionCacheService — trigger idempotency (EVO-1896)', () => {
  beforeEach(() => {
    mockKv.clear();
    mockSets.clear();
    jest.clearAllMocks();
  });

  it('claims a (journey, contact, messageId) the first time it is seen', async () => {
    const service = makeService(makeRepository());

    const first = await service.tryClaimTriggerMessage('j1', 'c1', 'm1');

    expect(first).toBe(true);
    expect(
      mockKv.has('evo-campaign:journey:dedup:j1:c1:m1'),
    ).toBe(true);
  });

  it('refuses a redelivered messageId (atomic SET NX returns null)', async () => {
    const service = makeService(makeRepository());

    const first = await service.tryClaimTriggerMessage('j1', 'c1', 'm1');
    const replay = await service.tryClaimTriggerMessage('j1', 'c1', 'm1');

    expect(first).toBe(true);
    expect(replay).toBe(false);
  });

  it('does not cross-block distinct journeys/contacts/messageIds', async () => {
    const service = makeService(makeRepository());

    await service.tryClaimTriggerMessage('j1', 'c1', 'm1');

    await expect(
      service.tryClaimTriggerMessage('j2', 'c1', 'm1'),
    ).resolves.toBe(true);
    await expect(
      service.tryClaimTriggerMessage('j1', 'c2', 'm1'),
    ).resolves.toBe(true);
    await expect(
      service.tryClaimTriggerMessage('j1', 'c1', 'm2'),
    ).resolves.toBe(true);
  });

  it('fails open (allows execution) when Redis errors', async () => {
    const service = makeService(makeRepository());
    jest
      .spyOn(service as any, 'ensureRedisConnected')
      .mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.tryClaimTriggerMessage('j1', 'c1', 'm1'),
    ).resolves.toBe(true);
  });
});

describe('JourneySessionCacheService — best-effort persistence on start path (EVO-1892)', () => {
  beforeEach(() => {
    mockKv.clear();
    mockSets.clear();
    jest.clearAllMocks();
  });

  it('does NOT throw when Postgres FK write fails and bestEffortPersist is set', async () => {
    const repo = makeRepository();
    // The contact is absent from evo_campaign.contacts → FK violation.
    repo.save.mockRejectedValue(
      new Error(
        'insert or update on table "journey_sessions" violates foreign key constraint "FK_journey_sessions_contact_id"',
      ),
    );
    const service = makeService(repo);

    await expect(
      service.set(makeSession('sess-be'), { bestEffortPersist: true }),
    ).resolves.toBeUndefined();

    // The session is still written to the shared Redis layer, so the runtime
    // (and the EVO-1691 guard's getSessionsByContact) can read it — the workflow
    // can advance off the cache despite the failed Postgres write.
    expect(mockKv.has('evo-campaign:journey-session:sess-be')).toBe(true);
  });

  it('still throws by default (durable write-through unchanged for other paths)', async () => {
    const repo = makeRepository();
    repo.save.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(repo);

    await expect(service.set(makeSession('sess-d'))).rejects.toThrow('db down');
  });

  it('updateSessionStatus stays best-effort end-to-end when asked (no throw on FK)', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    // Seed the session into the cache (best-effort create succeeded in Redis).
    await service.set(makeSession('sess-up'), { bestEffortPersist: true });
    // Now the contact is still absent → every subsequent Postgres write FK-fails.
    repo.save.mockRejectedValue(
      new Error('violates foreign key constraint "FK_journey_sessions_contact_id"'),
    );

    await expect(
      service.updateSessionStatus(
        'sess-up',
        'active',
        { workflowId: 'wf-1', workflowRunId: 'run-1' },
        { bestEffortPersist: true },
      ),
    ).resolves.toBeUndefined();

    const seen = await service.get('sess-up');
    expect(seen?.status).toBe('active');
    expect(seen?.workflowId).toBe('wf-1');
  });

  it('updateSessionStatus still throws on FK without the best-effort flag', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    await service.set(makeSession('sess-up2'), { bestEffortPersist: true });
    repo.save.mockRejectedValue(new Error('db down'));

    await expect(
      service.updateSessionStatus('sess-up2', 'completed'),
    ).rejects.toThrow('db down');
  });
});

describe('JourneySessionCacheService — lazy contact upsert satisfies FK (EVO-1929)', () => {
  beforeEach(() => {
    mockKv.clear();
    mockSets.clear();
    jest.clearAllMocks();
  });

  it('upserts a minimal contacts row before saving a session for a CRM-only contact', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    const session = makeSession('sess-fk');
    (session as unknown as { contactId: string }).contactId = 'crm-only-contact';

    await service.set(session);

    // The contact row is ensured BEFORE the session is persisted, so the
    // FK_journey_sessions_contact_id constraint is always satisfied.
    expect(repo.manager.query).toHaveBeenCalledWith(
      'INSERT INTO contacts (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      ['crm-only-contact'],
    );
    const upsertOrder = repo.manager.query.mock.invocationCallOrder[0];
    const saveOrder = repo.save.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(saveOrder);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('runs the idempotent upsert on per-node runtime writes (not just start)', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    // First write creates the session (and ensures the contact)...
    await service.set(makeSession('sess-runtime'));
    repo.manager.query.mockClear();

    // ...a subsequent per-node status transition (the runtime path that used
    // to FK-fail) also runs the idempotent upsert.
    await service.updateSessionStatus('sess-runtime', 'completed', {
      completedAt: new Date('2026-06-03T00:00:00Z'),
    });

    expect(repo.manager.query).toHaveBeenCalledWith(
      'INSERT INTO contacts (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      ['contact-1'],
    );
  });

  it('skips the upsert when the session has no contact id', async () => {
    const repo = makeRepository();
    const service = makeService(repo);

    const session = makeSession('sess-no-contact');
    (session as unknown as { contactId?: string }).contactId = undefined;

    await service.set(session);

    expect(repo.manager.query).not.toHaveBeenCalled();
  });
});
