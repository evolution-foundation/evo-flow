import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseCacheService } from './base-cache.service';
import { CacheConfig } from '../interfaces/cache.interfaces';
import { ShortLink } from 'src/modules/click-tracking/entities/short-link.entity';
import { CachedShortLink } from 'src/modules/click-tracking/interfaces';

@Injectable()
export class LinkCacheService extends BaseCacheService<
  ShortLink,
  CachedShortLink
> {
  constructor(
    @InjectRepository(ShortLink)
    repository: Repository<ShortLink>,
    eventEmitter: EventEmitter2,
  ) {
    const cacheConfig: CacheConfig = {
      redisKeyPrefix: 'evo-campaign:short-link',
      memoryMaxSize: 10000,
      memoryTtlMs: 60 * 60 * 1000,
      redisTtlSeconds: 24 * 60 * 60,
      enableL2Cache: true,
      enableStats: true,
    };

    super(repository, eventEmitter, cacheConfig, LinkCacheService.name);
  }

  async getByShortCode(shortCode: string): Promise<CachedShortLink | null> {
    const shortCodeKey = this.getShortCodeCacheKey(shortCode);
    this.stats.totalRequests++;

    try {
      if (this.cacheConfig.enableL2Cache) {
        const memoryResult = this.memoryCache.get(shortCodeKey);
        if (memoryResult) {
          this.stats.l2CacheHits++;
          return memoryResult;
        }
        this.stats.l2CacheMisses++;
      }

      await this.ensureRedisConnected();
      const redisResult = await this.redis.get(shortCodeKey);
      if (redisResult) {
        const cached = JSON.parse(redisResult) as CachedShortLink;
        this.stats.l1CacheHits++;

        if (this.cacheConfig.enableL2Cache) {
          this.memoryCache.set(shortCodeKey, cached);
        }

        return cached;
      }
      this.stats.l1CacheMisses++;

      const dbResult = await this.repository.findOne({
        where: { shortCode },
        relations: ['parameters'],
      });

      if (dbResult) {
        this.stats.databaseHits++;
        const cached = this.transformToCached(dbResult);

        await this.cacheShortCode(shortCode, cached);

        return cached;
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Cache error for short code ${shortCode}: ${error.message}`,
        error.stack,
      );

      const dbResult = await this.repository.findOne({
        where: { shortCode },
        relations: ['parameters'],
      });
      return dbResult ? this.transformToCached(dbResult) : null;
    }
  }

  async incrementClickCount(shortCode: string): Promise<number> {
    try {
      await this.ensureRedisConnected();
      const counterKey = `${this.cacheConfig.redisKeyPrefix}:clicks:${shortCode}`;

      const newCount = await this.redis.incr(counterKey);

      if (newCount === 1) {
        await this.redis.expire(counterKey, this.cacheConfig.redisTtlSeconds);
      }

      return newCount;
    } catch (error) {
      this.logger.error(
        `Failed to increment click count for ${shortCode}: ${error.message}`,
      );
      return 0;
    }
  }

  async getClickCount(shortCode: string): Promise<number> {
    try {
      await this.ensureRedisConnected();
      const counterKey = `${this.cacheConfig.redisKeyPrefix}:clicks:${shortCode}`;
      const count = await this.redis.get(counterKey);
      return count ? parseInt(count, 10) : 0;
    } catch (error) {
      this.logger.warn(
        `Failed to get click count for ${shortCode}: ${error.message}`,
      );
      return 0;
    }
  }

  async set(entity: ShortLink): Promise<void> {
    await super.set(entity);

    const cached = this.transformToCached(entity);
    await this.cacheShortCode(entity.shortCode, cached);
  }

  async invalidate(id: string): Promise<void> {
    const entity = await this.repository.findOne({
      where: { id },
    });

    if (entity) {
      await this.invalidateShortCode(entity.shortCode);
    }

    await super.invalidate(id);
  }

  protected getEntityName(): string {
    return 'ShortLink';
  }

  protected transformToCached(entity: ShortLink): CachedShortLink {
    return {
      id: entity.id,
      shortCode: entity.shortCode,
      originalUrl: entity.originalUrl,
      campaignId: entity.campaignId,
      journeyId: entity.journeyId,
      contactId: entity.contactId,
      isActive: entity.isActive,
      clickCount: entity.clickCount,
      expiresAt: entity.expiresAt,
      parameters: entity.parameters?.map((p) => ({
        key: p.key,
        value: p.value,
        isUtm: p.isUtm,
      })),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      lastCached: new Date(),
    };
  }

  protected async getFromDatabase(id: string): Promise<ShortLink | null> {
    return this.repository.findOne({
      where: { id },
      relations: ['parameters'],
    });
  }

  protected async getMultipleFromDatabase(ids: string[]): Promise<ShortLink[]> {
    return this.repository
      .createQueryBuilder('link')
      .leftJoinAndSelect('link.parameters', 'parameters')
      .where('link.id IN (:...ids)', { ids })
      .getMany();
  }

  protected async getAllFromDatabase(limit?: number): Promise<ShortLink[]> {
    const query = this.repository
      .createQueryBuilder('link')
      .leftJoinAndSelect('link.parameters', 'parameters')
      .orderBy('link.createdAt', 'DESC');

    if (limit) {
      query.take(limit);
    }

    return query.getMany();
  }

  private getShortCodeCacheKey(shortCode: string): string {
    return `${this.cacheConfig.redisKeyPrefix}:code:${shortCode}`;
  }

  private async cacheShortCode(
    shortCode: string,
    cached: CachedShortLink,
  ): Promise<void> {
    const shortCodeKey = this.getShortCodeCacheKey(shortCode);

    await this.ensureRedisConnected();
    await this.redis.setex(
      shortCodeKey,
      this.cacheConfig.redisTtlSeconds,
      JSON.stringify(cached),
    );

    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.set(shortCodeKey, cached);
    }
  }

  private async invalidateShortCode(shortCode: string): Promise<void> {
    const shortCodeKey = this.getShortCodeCacheKey(shortCode);

    await this.ensureRedisConnected();
    await this.redis.del(shortCodeKey);

    if (this.cacheConfig.enableL2Cache) {
      this.memoryCache.delete(shortCodeKey);
    }

    const counterKey = `${this.cacheConfig.redisKeyPrefix}:clicks:${shortCode}`;
    await this.redis.del(counterKey);
  }
}
