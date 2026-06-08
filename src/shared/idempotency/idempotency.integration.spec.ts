/**
 * Integration tests for IdempotencyService against a real Redis.
 *
 * Opt-in: set `REDIS_INTEGRATION=1`. Otherwise this suite is skipped so the
 * runner doesn't need Redis in plain unit runs.
 *
 * Local setup:
 *   docker compose -f docker-compose.local.yaml up -d redis
 *   REDIS_INTEGRATION=1 npm test -- idempotency.integration
 */
import Redis from 'ioredis';
import { getProcessingConfig } from 'src/modules/processing/config/processing.config';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyMetrics } from './idempotency.metrics';

const integrationEnabled = process.env.REDIS_INTEGRATION === '1';
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('IdempotencyService (integration)', () => {
  let service: IdempotencyService;
  let metrics: IdempotencyMetrics;
  let control: Redis;
  const stamp = Date.now();

  beforeAll(() => {
    metrics = new IdempotencyMetrics();
    service = new IdempotencyService(metrics);
    service.onModuleInit();

    const config = getProcessingConfig();
    control = new Redis({
      host: config.redis?.host ?? 'localhost',
      port: config.redis?.port ?? 6379,
      password: config.redis?.password,
      db: config.redis?.db ?? 5,
    });
  }, 30_000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await control.quit();
  });

  it('AC1: first checkAndMark returns true and the key has TTL ~3600s', async () => {
    const hash = service.computeHash(`ac1-${stamp}`);
    await expect(service.checkAndMark(hash)).resolves.toBe(true);

    const ttl = await control.ttl(`event:idempotency:${hash}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('AC2: the same hash within the TTL returns false', async () => {
    const hash = service.computeHash(`ac2-${stamp}`);
    await expect(service.checkAndMark(hash)).resolves.toBe(true);
    await expect(service.checkAndMark(hash)).resolves.toBe(false);
  });

  it('AC3: 100 concurrent calls with the same hash → exactly 1 true, 99 false', async () => {
    const hash = service.computeHash(`ac3-${stamp}`);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => service.checkAndMark(hash)),
    );
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(99);
  });

  it('AC4: a duplicate (false) increments the hits metric', async () => {
    const hash = service.computeHash(`ac4-${stamp}`);
    const before = await readCounter(metrics, 'idempotency_hits_total');
    await service.checkAndMark(hash); // first → miss
    await service.checkAndMark(hash); // duplicate → hit
    const after = await readCounter(metrics, 'idempotency_hits_total');
    expect(after - before).toBe(1);
  });

  it('lock: acquire returns a token, a second acquire is blocked, release frees it', async () => {
    const hash = service.computeHash(`lock-${stamp}`);
    const token = await service.acquireLock(hash);
    expect(token).not.toBeNull();
    await expect(service.acquireLock(hash)).resolves.toBeNull();
    await expect(service.releaseLock(hash, token!)).resolves.toBe(true);
    await expect(service.acquireLock(hash)).resolves.not.toBeNull();
  });
});

async function readCounter(
  metrics: IdempotencyMetrics,
  name: string,
): Promise<number> {
  const snapshot = await metrics.hits.get();
  if (snapshot.name !== name) return 0;
  return snapshot.values.reduce((sum, v) => sum + v.value, 0);
}
