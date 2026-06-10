import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Counter, register } from 'prom-client';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { getProcessingConfig } from '../../../modules/processing/config/processing.config';

const RATE_LIMIT_KEY_PREFIX = 'send:ratelimit:';
const DEFAULT_CAPACITY = 100;
const DEFAULT_REFILL_RATE = 100;
const RATE_LIMIT_BLOCKS_METRIC = 'evo_flow_rate_limit_blocks_total';

/**
 * Token bucket, executed atomically by Redis' single-threaded Lua runtime —
 * the property that lets every sender replica share the same per-inbox bucket
 * (NFR2). State is one hash per inbox (`tokens` + `last_refill`) under the
 * standardized `send:ratelimit:<inboxId>` key.
 *
 * Time comes from `redis.call('TIME')` (server clock, microsecond precision):
 * replicas never need synchronized local clocks, and a clock-skewed replica
 * cannot mint extra tokens. Refill is fractional and capped at capacity. The
 * bucket expires after ~2 full-refill windows so idle inboxes don't leak keys.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])

local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1e6

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil or last_refill == nil then
  tokens = capacity
  last_refill = now
else
  local delta = math.max(0, now - last_refill) * refill_rate
  tokens = math.min(capacity, tokens + delta)
  last_refill = now
end

local acquired = 0
if tokens >= 1 then
  tokens = tokens - 1
  acquired = 1
end

redis.call('HSET', key, 'tokens', tokens, 'last_refill', last_refill)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_rate * 2000))

return acquired
`;

interface RateLimiterRedis extends Redis {
  rateLimiterAcquire(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<number>;
}

/**
 * Distributed per-inbox rate limiter for the campaign-sender (story 4.4 /
 * EVO-1218). `acquire(inboxId)` consumes one token from the inbox's shared
 * Redis bucket and reports whether the dispatch may proceed; a depleted bucket
 * increments `evo_flow_rate_limit_blocks_total{inbox_id}`.
 *
 * The Lua script is registered via ioredis `defineCommand`, which runs EVALSHA
 * on the hot path and transparently falls back to EVAL (re-loading the script)
 * on NOSCRIPT — e.g. after a Redis restart.
 *
 * Capacity/refill come from `RATE_LIMITER_CAPACITY` and
 * `RATE_LIMITER_REFILL_RATE` (tokens/s, default 100/100), global for all
 * inboxes in the MVP. Redis being unavailable is NOT handled here by design
 * (assume up; fallback is a future hardening story) — a connection error
 * propagates and the consumer's ack policy requeues the batch.
 */
@Injectable()
export class RateLimiterService implements OnModuleInit, OnModuleDestroy {
  private redis: RateLimiterRedis | null = null;
  private capacity = DEFAULT_CAPACITY;
  private refillRate = DEFAULT_REFILL_RATE;
  private readonly mode = process.env.RUN_MODE ?? 'unknown';
  private readonly blocksTotal: Counter<string>;

  constructor(private readonly logger: CustomLoggerService) {
    this.blocksTotal =
      (register.getSingleMetric(RATE_LIMIT_BLOCKS_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: RATE_LIMIT_BLOCKS_METRIC,
        help: 'Blocked acquire attempts on the per-inbox token bucket (a single dispatch may count up to 4 — initial try + 3 retries)',
        labelNames: ['mode', 'inbox_id'],
      });
  }

  onModuleInit(): void {
    this.capacity = this.envInt('RATE_LIMITER_CAPACITY', DEFAULT_CAPACITY);
    this.refillRate = this.envInt(
      'RATE_LIMITER_REFILL_RATE',
      DEFAULT_REFILL_RATE,
    );

    const config = getProcessingConfig();
    // lazyConnect: socket opens on the first acquire, so Redis being down at
    // boot does not crash the runner before it even receives a message.
    const redis = new Redis({
      host: config.redis?.host ?? 'localhost',
      port: config.redis?.port ?? 6379,
      password: config.redis?.password,
      db: config.redis?.db ?? 5,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    }) as RateLimiterRedis;

    redis.defineCommand('rateLimiterAcquire', {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });

    this.redis = redis;
    this.logger.log('rate-limiter.ready', {
      action: 'rate-limiter.ready',
      capacity: this.capacity,
      refillRate: this.refillRate,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      // Best-effort shutdown; the process is exiting.
    }
    this.redis = null;
  }

  /**
   * Consume one token from `inboxId`'s bucket. `true` → dispatch may proceed;
   * `false` → bucket depleted (block counted, caller applies backpressure).
   */
  async acquire(inboxId: string): Promise<boolean> {
    const redis = this.assertReady();
    const acquired = await redis.rateLimiterAcquire(
      `${RATE_LIMIT_KEY_PREFIX}${inboxId}`,
      this.capacity,
      this.refillRate,
    );
    if (acquired === 1) return true;

    this.blocksTotal.labels(this.mode, inboxId).inc();
    return false;
  }

  private envInt(name: string, fallback: number): number {
    const parsed = parseInt(process.env[name] ?? String(fallback), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private assertReady(): RateLimiterRedis {
    if (!this.redis) {
      throw new Error(
        'RateLimiterService used before its Redis connection was established (onModuleInit).',
      );
    }
    return this.redis;
  }
}
