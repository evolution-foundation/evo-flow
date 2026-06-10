import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getProcessingConfig } from '../../processing/config/processing.config';
import {
  CacheableEntity,
  CachedEntity,
  CacheStats,
  CacheConfig,
  EntityCacheService,
} from '../interfaces/cache.interfaces';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { RedisSingleton } from './redis-singleton.service';

/**
 * Base Cache Service (single-account)
 * Generic 2-layer cache service that can be extended for any entity.
 */
@Injectable()
export abstract class BaseCacheService<
    T extends CacheableEntity,
    C extends CachedEntity,
  >
  implements EntityCacheService<T, C>, OnModuleDestroy
{
  protected readonly logger: CustomLoggerService;
  protected readonly config = getProcessingConfig();
  protected readonly cacheConfig: CacheConfig;

  // NOTE: the L1/L2 naming here is inverted vs. the usual convention —
  // L1 = Redis (shared across instances, always on) and L2 = in-memory LRU
  // (local to the instance, gated by `enableL2Cache`). Disabling "L2" does
  // NOT make the cache in-process-only; it removes the local layer.

  // Redis L1 cache - shared across instances
  protected redis: Redis;

  // Memory L2 cache - local to instance, most used items
  protected memoryCache: LRUCache<string, C>;

  // Cache statistics
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
    protected repository: Repository<T>,
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
   * L2 (Memory) -> L1 (Redis) -> Database
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

      const dbResult = await this.getFromDatabase(id);
      if (dbResult) {
        this.stats.databaseHits++;
        const cachedEntity = this.transformToCached(dbResult);

        await this.setInRedis(cacheKey, cachedEntity);
        if (this.cacheConfig.enableL2Cache) {
          this.memoryCache.set(cacheKey, cachedEntity);
        }

        this.updateHitRate();
        return cachedEntity;
      }

      this.updateHitRate();
      return null;
    } catch (error) {
      this.logger.error(
        `Cache error for ${this.getEntityName()} ${id}: ${error.message}`,
        error.stack,
      );
      const dbResult = await this.getFromDatabase(id);
      return dbResult ? this.transformToCached(dbResult) : null;
    }
  }

  /**
   * Get multiple entities with batch optimization
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
        const dbResults = await this.getMultipleFromDatabase(stillUncachedIds);
        for (const dbResult of dbResults) {
          const cached = this.transformToCached(dbResult);
          results.push(cached);

          const key = this.getCacheKey(dbResult.id);
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
   * Get all entities (single-account: every entity in the workspace)
   */
  async getAll(limit?: number): Promise<C[]> {
    const indexKey = `${this.cacheConfig.redisKeyPrefix}:index`;

    try {
      await this.ensureRedisConnected();

      let entityIds: string[] = [];
      try {
        entityIds = await this.redis.smembers(indexKey);
      } catch (typeError) {
        if (typeError.message.includes('WRONGTYPE')) {
          this.logger.warn(
            `Unexpected key type for cache index ${indexKey}, rebuilding`,
          );
          await this.redis.del(indexKey);
          entityIds = [];
        } else {
          throw typeError;
        }
      }

      if (entityIds.length > 0) {
        const limitedIds = limit ? entityIds.slice(0, limit) : entityIds;
        return await this.getMultiple(limitedIds);
      }

      // Fallback to database
      const dbResults = await this.getAllFromDatabase(limit);
      const cached = dbResults.map((entity) => this.transformToCached(entity));

      if (dbResults.length > 0) {
        const entityIdsFromDb = dbResults.map((e) => e.id);

        await this.redis.sadd(indexKey, ...entityIdsFromDb);
        await this.redis.expire(indexKey, this.cacheConfig.redisTtlSeconds);

        for (const entity of dbResults) {
          const key = this.getCacheKey(entity.id);
          const cachedEntity = this.transformToCached(entity);
          await this.setInRedis(key, cachedEntity);
          if (this.cacheConfig.enableL2Cache) {
            this.memoryCache.set(key, cachedEntity);
          }
        }
      }

      return cached;
    } catch (error) {
      this.logger.error(
        `Error getting all ${this.getEntityName()}s: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Set/Update entity in cache
   */
  async set(entity: T): Promise<void> {
    const cacheKey = this.getCacheKey(entity.id);
    const cached = this.transformToCached(entity);

    await this.setInRedis(cacheKey, cached);
    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.set(cacheKey, cached);
    }

    await this.addToIndex(entity.id);

    this.logger.debug(`Cached ${this.getEntityName()} ${entity.id}`);
  }

  /**
   * Set multiple entities
   */
  async setMultiple(entities: T[]): Promise<void> {
    await this.ensureRedisConnected();
    const pipeline = this.redis.pipeline();

    for (const entity of entities) {
      const cacheKey = this.getCacheKey(entity.id);
      const cached = this.transformToCached(entity);

      pipeline.setex(
        cacheKey,
        this.cacheConfig.redisTtlSeconds,
        JSON.stringify(cached),
      );

      if (this.cacheConfig.enableL2Cache) {
        this.memoryCache.set(cacheKey, cached);
      }
    }

    await pipeline.exec();

    await this.addMultipleToIndex(entities.map((e) => e.id));

    this.logger.debug(`Cached ${entities.length} ${this.getEntityName()}s`);
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

    await this.removeFromIndex(id);

    this.logger.debug(`Invalidated cache for ${this.getEntityName()} ${id}`);
  }

  /**
   * Invalidate all entities
   */
  async invalidateAll(): Promise<void> {
    await this.ensureRedisConnected();
    const indexKey = `${this.cacheConfig.redisKeyPrefix}:index`;

    const entityIds = await this.redis.smembers(indexKey);

    if (entityIds.length > 0) {
      const entityKeys = entityIds.map((id) => this.getCacheKey(id));
      await this.redis.del(...entityKeys);

      if (this.cacheConfig.enableL2Cache) {
        for (const key of entityKeys) {
          this.memoryCache.delete(key);
        }
      }
    }

    await this.redis.del(indexKey);
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

  // Abstract methods - must be implemented by concrete classes
  protected abstract getEntityName(): string;
  protected abstract transformToCached(entity: T): C;
  protected abstract getFromDatabase(id: string): Promise<T | null>;
  protected abstract getMultipleFromDatabase(ids: string[]): Promise<T[]>;
  protected abstract getAllFromDatabase(limit?: number): Promise<T[]>;

  // Private helpers
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

    if (status === 'ready') {
      return;
    }

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

  // Index management
  private async addToIndex(entityId: string): Promise<void> {
    try {
      await this.ensureRedisConnected();
      const indexKey = `${this.cacheConfig.redisKeyPrefix}:index`;

      try {
        await this.redis.sadd(indexKey, entityId);
      } catch (typeError) {
        if (typeError.message.includes('WRONGTYPE')) {
          await this.redis.del(indexKey);
          await this.redis.sadd(indexKey, entityId);
        } else {
          throw typeError;
        }
      }

      await this.redis.expire(indexKey, this.cacheConfig.redisTtlSeconds);
    } catch (error) {
      this.logger.warn(
        `Failed to add ${entityId} to cache index: ${error.message}`,
      );
    }
  }

  private async addMultipleToIndex(entityIds: string[]): Promise<void> {
    if (entityIds.length === 0) return;

    try {
      await this.ensureRedisConnected();
      const indexKey = `${this.cacheConfig.redisKeyPrefix}:index`;

      try {
        await this.redis.sadd(indexKey, ...entityIds);
      } catch (typeError) {
        if (typeError.message.includes('WRONGTYPE')) {
          await this.redis.del(indexKey);
          await this.redis.sadd(indexKey, ...entityIds);
        } else {
          throw typeError;
        }
      }

      await this.redis.expire(indexKey, this.cacheConfig.redisTtlSeconds);
    } catch (error) {
      this.logger.warn(
        `Failed to add multiple entities to cache index: ${error.message}`,
      );
    }
  }

  private async removeFromIndex(entityId: string): Promise<void> {
    try {
      await this.ensureRedisConnected();
      const indexKey = `${this.cacheConfig.redisKeyPrefix}:index`;
      await this.redis.srem(indexKey, entityId);
    } catch (error) {
      this.logger.warn(
        `Failed to remove ${entityId} from cache index: ${error.message}`,
      );
    }
  }
}
