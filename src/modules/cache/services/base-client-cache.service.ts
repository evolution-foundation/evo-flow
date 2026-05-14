import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getProcessingConfig } from '../../processing/config/processing.config';
import {
  CachedEntity,
  CacheStats,
  CacheConfig,
} from '../interfaces/cache.interfaces';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { RedisSingleton } from './redis-singleton.service';

/**
 * Base Cache Service for upstream-backed entities (no TypeORM Repository).
 *
 * Mirrors `BaseCacheService` but fetches missing entries from an upstream
 * client (e.g. `ContactsClientService`) instead of a local Postgres
 * Repository. Public surface (get / getMultiple / invalidate / invalidateAll
 * / set / setMultiple / getStats / healthCheck) matches `BaseCacheService`
 * so callers can swap implementations.
 *
 * Concrete subclasses implement:
 *  - getEntityName(): logical name for logging / event topics
 *  - mapUpstream(raw): transform upstream DTO into the cached shape
 *  - fetchFromUpstream(id): fetch a single entity by id
 *  - fetchMultipleFromUpstream(ids): batch fetch
 *
 * The original `BaseCacheService` is intentionally not modified because
 * multiple other caches (journey, journey-session, segment, link) still
 * depend on the Repository-backed path.
 */
@Injectable()
export abstract class BaseClientCacheService<
  Raw,
  C extends CachedEntity,
> implements OnModuleDestroy {
  protected readonly logger: CustomLoggerService;
  protected readonly config = getProcessingConfig();
  protected readonly cacheConfig: CacheConfig;

  protected redis: Redis;
  protected memoryCache: LRUCache<string, C>;

  protected stats: CacheStats = {
    l1CacheHits: 0,
    l1CacheMisses: 0,
    l2CacheHits: 0,
    l2CacheMisses: 0,
    databaseHits: 0,
    totalRequests: 0,
    l1CacheSize: 0,
    l2CacheSize: 0,
    hitRatePercent: 0,
  };

  constructor(
    protected eventEmitter: EventEmitter2,
    cacheConfig: CacheConfig,
    loggerName: string,
  ) {
    this.logger = new CustomLoggerService(loggerName);
    this.cacheConfig = cacheConfig;
    this.initializeRedisAsync();
    this.initializeMemoryCache();
    this.setupEventListeners();
  }

  private initializeRedisAsync() {
    this.initializeRedis().catch((error) => {
      this.logger.error(
        `Failed to initialize Redis for ${this.getEntityName()}: ${error.message}`,
      );
    });
  }

  /**
   * Get entity with 2-layer cache strategy
   * L2 (Memory) -> L1 (Redis) -> Upstream client
   */
  async get(id: string): Promise<C | null> {
    this.stats.totalRequests++;
    const cacheKey = this.getCacheKey(id);

    try {
      if (this.cacheConfig.enableL2Cache) {
        const memoryResult = this.memoryCache.get(cacheKey);
        if (memoryResult) {
          this.stats.l2CacheHits++;
          this.updateHitRate();
          return memoryResult;
        }
        this.stats.l2CacheMisses++;
      }

      const redisResult = await this.getFromRedis(cacheKey);
      if (redisResult) {
        this.stats.l1CacheHits++;
        if (this.cacheConfig.enableL2Cache) {
          this.memoryCache.set(cacheKey, redisResult);
        }
        this.updateHitRate();
        return redisResult;
      }
      this.stats.l1CacheMisses++;

      const upstream = await this.fetchFromUpstream(id);
      if (upstream) {
        this.stats.databaseHits++;
        const cached = this.mapUpstream(upstream);
        await this.setInRedis(cacheKey, cached);
        if (this.cacheConfig.enableL2Cache) {
          this.memoryCache.set(cacheKey, cached);
        }
        this.updateHitRate();
        return cached;
      }

      this.updateHitRate();
      return null;
    } catch (error) {
      this.logger.error(
        `Cache error for ${this.getEntityName()} ${id}: ${error.message}`,
        error.stack,
      );
      const upstream = await this.fetchFromUpstream(id);
      return upstream ? this.mapUpstream(upstream) : null;
    }
  }

  /**
   * Get multiple entities with batch optimization. Missing ids are fetched
   * from upstream in a single `fetchMultipleFromUpstream` call.
   */
  async getMultiple(ids: string[]): Promise<C[]> {
    const results: C[] = [];
    const uncachedIds: string[] = [];
    const cacheKeys = ids.map((id) => this.getCacheKey(id));

    if (this.cacheConfig.enableL2Cache) {
      for (let i = 0; i < ids.length; i++) {
        const cached = this.memoryCache.get(cacheKeys[i]);
        if (cached) {
          results.push(cached);
          this.stats.l2CacheHits++;
        } else {
          uncachedIds.push(ids[i]);
          this.stats.l2CacheMisses++;
        }
      }
    } else {
      uncachedIds.push(...ids);
    }

    if (uncachedIds.length > 0) {
      await this.ensureRedisConnected();
      const redisResults = await this.redis.mget(
        uncachedIds.map((id) => this.getCacheKey(id)),
      );

      const stillUncachedIds: string[] = [];
      for (let i = 0; i < uncachedIds.length; i++) {
        if (redisResults[i]) {
          const parsed = JSON.parse(redisResults[i] as string) as C;
          results.push(parsed);
          if (this.cacheConfig.enableL2Cache) {
            this.memoryCache.set(this.getCacheKey(uncachedIds[i]), parsed);
          }
          this.stats.l1CacheHits++;
        } else {
          stillUncachedIds.push(uncachedIds[i]);
          this.stats.l1CacheMisses++;
        }
      }

      if (stillUncachedIds.length > 0) {
        const upstreamResults = await this.fetchMultipleFromUpstream(
          stillUncachedIds,
        );
        for (const raw of upstreamResults) {
          const cached = this.mapUpstream(raw);
          results.push(cached);

          const key = this.getCacheKey(cached.id);
          await this.setInRedis(key, cached);
          if (this.cacheConfig.enableL2Cache) {
            this.memoryCache.set(key, cached);
          }
          this.stats.databaseHits++;
        }
      }
    }

    this.stats.totalRequests += ids.length;
    this.updateHitRate();
    return results;
  }

  /**
   * Set/Update entity in cache (caller provides already-shaped cached form).
   */
  async setCached(cached: C): Promise<void> {
    const cacheKey = this.getCacheKey(cached.id);
    await this.setInRedis(cacheKey, cached);
    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.set(cacheKey, cached);
    }
    this.logger.debug(`Cached ${this.getEntityName()} ${cached.id}`);
  }

  /**
   * Invalidate specific entity
   */
  async invalidate(id: string): Promise<void> {
    const cacheKey = this.getCacheKey(id);
    await this.ensureRedisConnected();
    await this.redis.del(cacheKey);
    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.delete(cacheKey);
    }
    this.logger.debug(`Invalidated cache for ${this.getEntityName()} ${id}`);
  }

  /**
   * Invalidate all known entries by scanning the key prefix.
   */
  async invalidateAll(): Promise<void> {
    await this.ensureRedisConnected();
    const pattern = `${this.cacheConfig.redisKeyPrefix}:*`;
    const stream = this.redis.scanStream({ match: pattern, count: 200 });
    const keys: string[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => keys.push(...batch));
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    if (keys.length > 0) {
      await this.redis.del(...keys);
      if (this.cacheConfig.enableL2Cache) {
        for (const key of keys) {
          this.memoryCache.delete(key);
        }
      }
    }
  }

  getStats(): CacheStats {
    if (this.cacheConfig.enableL2Cache) {
      this.stats.l2CacheSize = this.memoryCache.size;
    }
    return { ...this.stats };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureRedisConnected();
      await this.redis.ping();
      return true;
    } catch (error) {
      this.logger.error(`Cache health check failed: ${error.message}`);
      return false;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  // Abstract methods
  protected abstract getEntityName(): string;
  protected abstract mapUpstream(raw: Raw): C;
  protected abstract fetchFromUpstream(id: string): Promise<Raw | null>;
  protected abstract fetchMultipleFromUpstream(ids: string[]): Promise<Raw[]>;

  // Private helpers (mirror BaseCacheService for behavioural parity)
  private async initializeRedis() {
    const isTemporalContext = this.isInTemporalContext();

    if (isTemporalContext) {
      this.redis = await RedisSingleton.getInstance();
      return;
    }

    this.redis = new Redis({
      host: this.config.redis?.host || 'localhost',
      port: this.config.redis?.port || 6379,
      password: this.config.redis?.password,
      db: this.config.redis?.db || 5,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      keepAlive: 30000,
      connectTimeout: 10000,
      enableOfflineQueue: false,
    });

    this.redis.on('error', (error) => {
      this.logger.error(
        `${this.getEntityName()} cache Redis error: ${error.message}`,
      );
    });
  }

  private isInTemporalContext(): boolean {
    if ((this as any)._isForcedSingletonContext) {
      return true;
    }
    if (typeof global !== 'undefined' && (global as any).WorkflowInfo) {
      return true;
    }
    const stack = new Error().stack || '';
    if (
      stack.includes('temporal') ||
      stack.includes('activity') ||
      stack.includes('workflow') ||
      stack.includes('journey-execution.activities') ||
      stack.includes('journey-trigger-processor') ||
      stack.includes('JourneyTriggerProcessor')
    ) {
      return true;
    }
    const processTitle = process.title || '';
    if (
      processTitle.includes('temporal') ||
      process.env.RUN_MODE === 'temporal-worker' ||
      process.env.RUN_MODE === 'event-worker' ||
      process.env.RUN_MODE === 'http-server' ||
      process.env.RUN_MODE === 'full'
    ) {
      return true;
    }
    return false;
  }

  private initializeMemoryCache() {
    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache = new LRUCache<string, C>({
        max: this.cacheConfig.memoryMaxSize,
        ttl: this.cacheConfig.memoryTtlMs,
        allowStale: false,
        updateAgeOnGet: true,
        updateAgeOnHas: true,
      });
    }
  }

  private setupEventListeners() {
    this.eventEmitter.on(
      `${this.getEntityName().toLowerCase()}.created`,
      () => {
        void this.invalidateAll();
      },
    );
    this.eventEmitter.on(
      `${this.getEntityName().toLowerCase()}.updated`,
      (data: { id: string }) => {
        void this.invalidate(data.id);
      },
    );
    this.eventEmitter.on(
      `${this.getEntityName().toLowerCase()}.deleted`,
      (data: { id: string }) => {
        void this.invalidate(data.id);
      },
    );
  }

  private getCacheKey(id: string): string {
    return `${this.cacheConfig.redisKeyPrefix}:${id}`;
  }

  private async getFromRedis(key: string): Promise<C | null> {
    try {
      await this.ensureRedisConnected();
      const result = await this.redis.get(key);
      return result ? (JSON.parse(result) as C) : null;
    } catch (error) {
      this.logger.warn(
        `Redis get error for key ${key}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async setInRedis(key: string, value: C): Promise<void> {
    try {
      await this.ensureRedisConnected();
      await this.redis.setex(
        key,
        this.cacheConfig.redisTtlSeconds,
        JSON.stringify(value),
      );
    } catch (error) {
      this.logger.warn(
        `Redis set error for key ${key}: ${(error as Error).message}`,
      );
    }
  }

  private connectionPromise: Promise<void> | null = null;

  protected async ensureRedisConnected(): Promise<void> {
    if (!this.redis) {
      await this.initializeRedis();
    }
    const status = this.redis.status;
    if (status === 'ready') return;

    if (status === 'connecting') {
      if (this.connectionPromise) {
        await this.connectionPromise;
        return;
      }
    }

    if (status === 'close' || status === 'end' || status === 'wait') {
      if (!this.connectionPromise) {
        this.connectionPromise = this.connectToRedis();
      }
      try {
        await this.connectionPromise;
      } finally {
        this.connectionPromise = null;
      }
    }
  }

  private async connectToRedis(): Promise<void> {
    try {
      await this.redis.connect();
      await this.redis.ping();
    } catch (error) {
      this.logger.error(
        `${this.getEntityName()} cache Redis connection failed: ${error.message}`,
      );
      throw error;
    }
  }

  private updateHitRate() {
    if (this.cacheConfig.enableStats && this.stats.totalRequests > 0) {
      const totalHits =
        this.stats.l1CacheHits +
        this.stats.l2CacheHits +
        this.stats.databaseHits;
      this.stats.hitRatePercent = Math.round(
        (totalHits / this.stats.totalRequests) * 100,
      );
    }
  }
}
