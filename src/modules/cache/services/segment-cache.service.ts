import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Segment } from '../../segments/entities/segment.entity';
import { BaseCacheService } from './base-cache.service';
import { CacheConfig } from '../interfaces/cache.interfaces';

export interface CachedSegment {
  id: string;
  name: string;
  definition: any;
  status: string;
  contactsCount?: number;
  lastComputedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
}

/**
 * Segment Cache Service (single-account)
 */
@Injectable()
export class SegmentCacheService extends BaseCacheService<
  Segment,
  CachedSegment
> {
  constructor(
    @InjectRepository(Segment)
    repository: Repository<Segment>,
    eventEmitter: EventEmitter2,
  ) {
    const cacheConfig: CacheConfig = {
      redisKeyPrefix: 'evo-campaign:segment',
      memoryMaxSize: 0,
      memoryTtlMs: 0,
      redisTtlSeconds: 60 * 60,
      enableL2Cache: false,
      enableStats: true,
    };

    super(repository, eventEmitter, cacheConfig, SegmentCacheService.name);
  }

  async getSegmentsByStatus(status: string): Promise<CachedSegment[]> {
    const allSegments = await this.getAll();
    return allSegments.filter((segment) => segment.status === status);
  }

  async getComputedSegments(): Promise<CachedSegment[]> {
    return this.getSegmentsByStatus('computed');
  }

  async warmupCache(segmentIds?: string[]): Promise<void> {
    try {
      let targetSegmentIds = segmentIds;

      if (!targetSegmentIds) {
        const segments = await this.repository.find({
          order: { updatedAt: 'DESC' },
          take: 50,
        });
        targetSegmentIds = segments.map((s) => s.id);
      }

      this.logger.debug(
        `Warming up cache with ${targetSegmentIds.length} segments`,
      );

      const warmupPromises = targetSegmentIds.map(async (segmentId) => {
        try {
          await this.get(segmentId);
        } catch (error) {
          this.logger.warn(
            `Failed to warm up segment ${segmentId}: ${(error as Error).message}`,
          );
        }
      });

      await Promise.all(warmupPromises);

      this.logger.log(`Cache warmup completed`);
      this.eventEmitter.emit('segment.cache.warmed', {
        count: targetSegmentIds.length,
      });
    } catch (error) {
      this.logger.error(
        `Cache warmup failed: ${(error as Error).message}`,
      );
    }
  }

  async clearAllCaches(): Promise<void> {
    try {
      const keys = await this.redis.keys(
        `${this.cacheConfig.redisKeyPrefix}:*`,
      );
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }

      if (this.cacheConfig.enableL2Cache) {
        this.memoryCache.clear();
      }

      this.stats = {
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

      this.logger.log('All segment caches cleared');
    } catch (error) {
      this.logger.error(`Failed to clear caches: ${(error as Error).message}`);
    }
  }

  // Preserve existing API compatibility
  async getSegment(segmentId: string): Promise<CachedSegment | null> {
    return this.get(segmentId);
  }

  getCacheStats() {
    return this.getStats();
  }

  async getAllSegments(limit?: number): Promise<CachedSegment[]> {
    return this.getAll(limit);
  }

  async cacheSegment(segment: any): Promise<void> {
    const cacheKey = this.buildCacheKey(segment.id);
    const cachedSegment: CachedSegment = {
      id: segment.id,
      name: segment.name,
      definition: segment.definition,
      status: segment.status,
      contactsCount: segment.contactsCount,
      lastComputedAt: segment.lastComputedAt,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
      lastCached: new Date(),
    };

    await this.storeInRedis(cacheKey, cachedSegment);

    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.set(cacheKey, cachedSegment);
    }
  }

  private buildCacheKey(id: string): string {
    return `${this.cacheConfig.redisKeyPrefix}:${id}`;
  }

  private async storeInRedis(key: string, value: CachedSegment): Promise<void> {
    try {
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

  async invalidateSegment(segmentId: string): Promise<void> {
    await this.invalidate(segmentId);

    this.eventEmitter.emit('segment.cache.invalidated', {
      segmentId,
    });
  }

  async invalidateAllSegments(): Promise<void> {
    await this.invalidateAll();

    this.eventEmitter.emit('segment.cache.all.invalidated', {});
  }

  protected getEntityName(): string {
    return 'Segment';
  }

  protected transformToCached(segment: Segment): CachedSegment {
    return {
      id: segment.id,
      name: segment.name,
      definition: segment.definition,
      status: segment.status,
      contactsCount: segment.contactsCount,
      lastComputedAt: segment.lastComputedAt,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
      lastCached: new Date(),
    };
  }

  protected async getFromDatabase(id: string): Promise<Segment | null> {
    return this.repository.findOne({
      where: { id },
    });
  }

  protected async getMultipleFromDatabase(ids: string[]): Promise<Segment[]> {
    return this.repository.find({
      where: { id: { $in: ids } as any },
    });
  }

  protected async getAllFromDatabase(limit?: number): Promise<Segment[]> {
    const query = this.repository
      .createQueryBuilder('segment')
      .orderBy('segment.updated_at', 'DESC');

    if (limit) {
      query.take(limit);
    }

    return query.getMany();
  }
}
