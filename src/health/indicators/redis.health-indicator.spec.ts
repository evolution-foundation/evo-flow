const mockRedis = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn(),
  quit: jest.fn().mockResolvedValue(undefined),
};

// ioredis is `export = Redis`; mock the default constructor to return our stub.
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => mockRedis),
}));

import { RedisHealthIndicator } from './redis.health-indicator';

describe('RedisHealthIndicator', () => {
  let indicator: RedisHealthIndicator;

  beforeEach(async () => {
    jest.clearAllMocks();
    indicator = new RedisHealthIndicator();
    await indicator.onModuleInit();
  });

  it('connects a dedicated client and registers an error listener on init', () => {
    expect(mockRedis.connect).toHaveBeenCalled();
    expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('up when PING returns PONG', async () => {
    mockRedis.ping.mockResolvedValue('PONG');
    await expect(indicator.check()).resolves.toEqual({
      name: 'redis',
      status: 'up',
    });
  });

  it('down when PING rejects', async () => {
    mockRedis.ping.mockRejectedValue(new Error('NOAUTH'));
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'redis', status: 'down' });
    expect(result.error).toContain('NOAUTH');
  });

  it('down when PING returns an unexpected reply', async () => {
    mockRedis.ping.mockResolvedValue('WAT');
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'redis', status: 'down' });
  });
});
