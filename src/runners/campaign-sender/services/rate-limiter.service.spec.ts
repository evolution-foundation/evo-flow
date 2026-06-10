// ioredis is `export = Redis`; mock the default constructor inside the factory
// so `new Redis(...)` hands back our stub.
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

import Redis from 'ioredis';
import { Counter, register } from 'prom-client';
import { RateLimiterService } from './rate-limiter.service';

const mockRedisCtor = Redis as unknown as jest.Mock;

const BLOCKS_METRIC = 'evo_flow_rate_limit_blocks_total';

interface MockRedis {
  defineCommand: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  rateLimiterAcquire: jest.Mock;
}

describe('RateLimiterService', () => {
  let service: RateLimiterService;
  let mockRedis: MockRedis;
  const logger = { log: jest.fn(), warn: jest.fn() };
  const envBackup: Record<string, string | undefined> = {};

  const makeService = (): RateLimiterService => {
    const created = new RateLimiterService(logger as never);
    created.onModuleInit();
    return created;
  };

  beforeEach(() => {
    for (const name of ['RATE_LIMITER_CAPACITY', 'RATE_LIMITER_REFILL_RATE']) {
      envBackup[name] = process.env[name];
      delete process.env[name];
    }
    // Fresh counter per test — the service get-or-creates against the global
    // prom-client register, which would otherwise accumulate across tests.
    register.removeSingleMetric(BLOCKS_METRIC);

    mockRedis = {
      defineCommand: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue('OK'),
      rateLimiterAcquire: jest.fn(),
    };
    mockRedisCtor.mockReset();
    mockRedisCtor.mockImplementation(() => mockRedis);
    logger.log.mockReset();
    logger.warn.mockReset();

    service = makeService();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('registers the token-bucket Lua command lazily (no eager connect)', () => {
    const [name, definition] = mockRedis.defineCommand.mock.calls[0] as [
      string,
      { numberOfKeys: number; lua: string },
    ];
    expect(name).toBe('rateLimiterAcquire');
    expect(definition.numberOfKeys).toBe(1);
    expect(definition.lua).toContain("redis.call('TIME')");
    expect(mockRedisCtor).toHaveBeenCalledWith(
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(mockRedis.connect).not.toHaveBeenCalled();
  });

  it('acquires with the standardized key and default capacity/refill', async () => {
    mockRedis.rateLimiterAcquire.mockResolvedValue(1);

    await expect(service.acquire('inbox-a')).resolves.toBe(true);
    expect(mockRedis.rateLimiterAcquire).toHaveBeenCalledWith(
      'send:ratelimit:inbox-a',
      100,
      100,
    );
  });

  // AC5: env-provided capacity/refill reach the Lua script as ARGV.
  it('applies RATE_LIMITER_CAPACITY and RATE_LIMITER_REFILL_RATE from env', async () => {
    process.env.RATE_LIMITER_CAPACITY = '50';
    process.env.RATE_LIMITER_REFILL_RATE = '50';
    service = makeService();
    mockRedis.rateLimiterAcquire.mockResolvedValue(1);

    await service.acquire('inbox-a');

    expect(mockRedis.rateLimiterAcquire).toHaveBeenCalledWith(
      'send:ratelimit:inbox-a',
      50,
      50,
    );
  });

  it('falls back to defaults when env values are not positive integers', async () => {
    process.env.RATE_LIMITER_CAPACITY = '-1';
    process.env.RATE_LIMITER_REFILL_RATE = 'abc';
    service = makeService();
    mockRedis.rateLimiterAcquire.mockResolvedValue(1);

    await service.acquire('inbox-a');

    expect(mockRedis.rateLimiterAcquire).toHaveBeenCalledWith(
      'send:ratelimit:inbox-a',
      100,
      100,
    );
  });

  it('returns false on a depleted bucket and counts the block per inbox', async () => {
    mockRedis.rateLimiterAcquire.mockResolvedValue(0);

    await expect(service.acquire('inbox-b')).resolves.toBe(false);

    const metric = register.getSingleMetric(BLOCKS_METRIC) as Counter<string>;
    const { values } = await metric.get();
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(1);
    expect(values[0].labels).toMatchObject({ inbox_id: 'inbox-b' });
  });

  it('does not count blocks on successful acquires', async () => {
    mockRedis.rateLimiterAcquire.mockResolvedValue(1);

    await service.acquire('inbox-a');

    const metric = register.getSingleMetric(BLOCKS_METRIC) as Counter<string>;
    const { values } = await metric.get();
    expect(values).toEqual([]);
  });

  it('quits the connection on shutdown and refuses use before init', async () => {
    await service.onModuleDestroy();
    expect(mockRedis.quit).toHaveBeenCalled();

    await expect(service.acquire('inbox-a')).rejects.toThrow(
      'before its Redis connection',
    );
  });
});
