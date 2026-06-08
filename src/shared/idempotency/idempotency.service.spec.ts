// ioredis is `export = Redis`; mock the default constructor inside the factory
// (avoids the TDZ from referencing an outer var the hoisted factory runs before).
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

import Redis from 'ioredis';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyMetrics } from './idempotency.metrics';

const mockRedisCtor = Redis as unknown as jest.Mock;

interface MockRedis {
  defineCommand: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  set: jest.Mock;
  idempotencyCheckAndMark: jest.Mock;
  idempotencyReleaseLock: jest.Mock;
  options: { db: number };
}

describe('IdempotencyService', () => {
  let mockRedis: MockRedis;
  let metrics: IdempotencyMetrics;
  let service: IdempotencyService;

  beforeEach(() => {
    mockRedis = {
      defineCommand: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      set: jest.fn(),
      idempotencyCheckAndMark: jest.fn(),
      idempotencyReleaseLock: jest.fn(),
      options: { db: 5 },
    };
    mockRedisCtor.mockImplementation(() => mockRedis);
    metrics = new IdempotencyMetrics();
    service = new IdempotencyService(metrics);
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('registers both Lua commands on init without connecting eagerly (lazy)', () => {
    expect(mockRedis.defineCommand).toHaveBeenCalledWith(
      'idempotencyCheckAndMark',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    expect(mockRedis.defineCommand).toHaveBeenCalledWith(
      'idempotencyReleaseLock',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    // lazyConnect: no boot-time connect — the socket opens on first command.
    expect(mockRedis.connect).not.toHaveBeenCalled();
  });

  it('computeHash returns a stable SHA256 hex', () => {
    const hash = service.computeHash('payload');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(service.computeHash('payload')).toBe(hash);
    expect(service.computeHash('other')).not.toBe(hash);
  });

  it('checkAndMark returns true + counts a miss the first time', async () => {
    mockRedis.idempotencyCheckAndMark.mockResolvedValue(1);
    const missSpy = jest.spyOn(metrics.misses, 'inc');

    await expect(service.checkAndMark('h1')).resolves.toBe(true);

    expect(mockRedis.idempotencyCheckAndMark).toHaveBeenCalledWith(
      'event:idempotency:h1',
      '1',
      3600,
    );
    expect(missSpy).toHaveBeenCalledTimes(1);
  });

  it('checkAndMark returns false + counts a hit on a duplicate', async () => {
    mockRedis.idempotencyCheckAndMark.mockResolvedValue(0);
    const hitSpy = jest.spyOn(metrics.hits, 'inc');

    await expect(service.checkAndMark('h1')).resolves.toBe(false);
    expect(hitSpy).toHaveBeenCalledTimes(1);
  });

  it('acquireLock returns the token when free, null when held', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    await expect(service.acquireLock('h1', 'tok')).resolves.toBe('tok');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'event:lock:h1',
      'tok',
      'EX',
      60,
      'NX',
    );

    mockRedis.set.mockResolvedValueOnce(null);
    await expect(service.acquireLock('h1', 'tok2')).resolves.toBeNull();
  });

  it('releaseLock returns true only when compare-and-delete removed the key', async () => {
    mockRedis.idempotencyReleaseLock.mockResolvedValueOnce(1);
    await expect(service.releaseLock('h1', 'tok')).resolves.toBe(true);

    mockRedis.idempotencyReleaseLock.mockResolvedValueOnce(0);
    await expect(service.releaseLock('h1', 'tok')).resolves.toBe(false);
  });

  it('throws if used before onModuleInit established the connection', async () => {
    const fresh = new IdempotencyService(new IdempotencyMetrics());
    await expect(fresh.checkAndMark('x')).rejects.toThrow(
      /before its Redis connection/,
    );
  });
});
