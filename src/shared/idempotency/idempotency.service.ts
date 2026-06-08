import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'crypto';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { getProcessingConfig } from 'src/modules/processing/config/processing.config';
import { IdempotencyMetrics } from './idempotency.metrics';

const IDEMPOTENCY_KEY_PREFIX = 'event:idempotency:';
const LOCK_KEY_PREFIX = 'event:lock:';
const IDEMPOTENCY_TTL_SECONDS = 3600;
const LOCK_TTL_SECONDS = 60;

/**
 * SET-if-not-exists with TTL in one round-trip. Returns 1 the first time a key
 * is seen, 0 if it already existed — the atomicity is what makes concurrent
 * callers with the same hash resolve to exactly one winner.
 */
const CHECK_AND_MARK_LUA =
  "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 else return 0 end";

/**
 * Compare-and-delete: only release the lock if the caller still owns the token,
 * so a caller whose lock already expired can't delete a lock another holder
 * has since acquired.
 */
const RELEASE_LOCK_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

interface IdempotencyRedis extends Redis {
  idempotencyCheckAndMark(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<number>;
  idempotencyReleaseLock(key: string, token: string): Promise<number>;
}

/**
 * Shared, broker-agnostic exactly-once guard (EVO-1204). Computes a SHA256 of a
 * payload and uses an atomic Redis Lua script to mark-if-new, so the webhook
 * pipeline (story 3.5) can drop duplicate provider events even under broker
 * retries and concurrent replicas (FR32).
 */
@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(IdempotencyService.name);
  private redis: IdempotencyRedis | null = null;

  constructor(private readonly metrics: IdempotencyMetrics) {}

  onModuleInit(): void {
    const config = getProcessingConfig();
    // lazyConnect: the socket opens on the first command, not at boot — so a
    // Redis outage at boot does not crash run-modes that never use idempotency
    // (this @Global module loads in every mode; only story 3.5 actually uses it).
    const redis = new Redis({
      host: config.redis?.host ?? 'localhost',
      port: config.redis?.port ?? 6379,
      password: config.redis?.password,
      db: config.redis?.db ?? 5,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    }) as IdempotencyRedis;

    redis.defineCommand('idempotencyCheckAndMark', {
      numberOfKeys: 1,
      lua: CHECK_AND_MARK_LUA,
    });
    redis.defineCommand('idempotencyReleaseLock', {
      numberOfKeys: 1,
      lua: RELEASE_LOCK_LUA,
    });

    this.redis = redis;
    this.logger.log('idempotency.ready', {
      action: 'idempotency.ready',
      db: redis.options.db,
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

  computeHash(payload: string | Buffer): string {
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Mark `hash` as seen. Returns `true` the first time (caller should process),
   * `false` if it was already marked within the TTL (caller should drop).
   */
  async checkAndMark(hash: string): Promise<boolean> {
    const redis = this.assertReady();
    const first = await redis.idempotencyCheckAndMark(
      `${IDEMPOTENCY_KEY_PREFIX}${hash}`,
      '1',
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (first === 1) {
      this.metrics.misses.inc();
      return true;
    }
    this.metrics.hits.inc();
    return false;
  }

  /**
   * Acquire a short-lived safety lock for `hash`. Returns the lock token to
   * pass to `releaseLock`, or `null` if another holder owns it. Wired by story
   * 3.5 — included here as the building block.
   */
  async acquireLock(
    hash: string,
    token: string = randomUUID(),
  ): Promise<string | null> {
    const redis = this.assertReady();
    const ok = await redis.set(
      `${LOCK_KEY_PREFIX}${hash}`,
      token,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    return ok === 'OK' ? token : null;
  }

  async releaseLock(hash: string, token: string): Promise<boolean> {
    const redis = this.assertReady();
    const released = await redis.idempotencyReleaseLock(
      `${LOCK_KEY_PREFIX}${hash}`,
      token,
    );
    return released === 1;
  }

  private assertReady(): IdempotencyRedis {
    if (!this.redis) {
      throw new Error(
        'IdempotencyService used before its Redis connection was established (onModuleInit).',
      );
    }
    return this.redis;
  }
}
