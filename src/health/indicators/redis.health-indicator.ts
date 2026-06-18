import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import Redis from 'ioredis';
import { getProcessingConfig } from '../../modules/processing/config/processing.config';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { withTimeout } from '../with-timeout';

/**
 * Readiness probe for Redis: `PING` over a dedicated long-lived client.
 *
 * Options are deliberately probe-tuned (fail-fast), NOT mirrored from
 * `redis-singleton.service.ts` — a transient blip should surface as `down`
 * immediately instead of being retried for 10s.
 */
@Injectable()
export class RedisHealthIndicator
  implements HealthIndicator, OnModuleInit, OnModuleDestroy
{
  readonly name = 'redis';
  private readonly logger = new Logger(RedisHealthIndicator.name);
  private client: Redis | null = null;

  async onModuleInit(): Promise<void> {
    const redis = getProcessingConfig().redis;
    if (!redis) {
      this.logger.warn('No Redis config resolved; readiness will report down.');
      return;
    }
    this.client = new Redis({
      host: redis.host,
      port: redis.port,
      password: redis.password,
      db: redis.db,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 3000,
      enableOfflineQueue: false,
    });
    // ioredis emits 'error' on connection trouble; without a listener Node would
    // crash with an unhandled error event. A failed probe is reported by check().
    this.client.on('error', (err) =>
      this.logger.debug(`Redis health client error: ${err.message}`),
    );
    try {
      await this.client.connect();
    } catch (err) {
      // Tolerate boot-time failure — ioredis reconnects lazily and check()
      // reflects the live state on each probe.
      this.logger.warn(
        `Redis health client failed initial connect: ${(err as Error).message}`,
      );
    }
  }

  async check(): Promise<IndicatorResult> {
    if (!this.client) {
      return { name: this.name, status: 'down', error: 'redis not configured' };
    }
    try {
      const pong: string = await withTimeout(
        () => this.client!.ping(),
        2000,
        this.name,
      );
      if (pong !== 'PONG') {
        return {
          name: this.name,
          status: 'down',
          error: `unexpected PING reply: ${pong}`,
        };
      }
      return { name: this.name, status: 'up' };
    } catch (err) {
      return { name: this.name, status: 'down', error: (err as Error).message };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
