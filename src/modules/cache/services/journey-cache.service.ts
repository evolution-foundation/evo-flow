import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Journey } from '../../journeys/entities/journey.entity';
import { BaseCacheService } from './base-cache.service';
import { CacheConfig } from '../interfaces/cache.interfaces';

export interface CachedJourney {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  flowData: any;
  flowTriggers: any[];
  variables: any[];
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
}

/**
 * Journey Cache Service (single-account)
 */
@Injectable()
export class JourneyCacheService extends BaseCacheService<
  Journey,
  CachedJourney
> {
  constructor(
    @InjectRepository(Journey)
    repository: Repository<Journey>,
    eventEmitter: EventEmitter2,
  ) {
    const cacheConfig: CacheConfig = {
      redisKeyPrefix: 'evo-campaign:journey',
      memoryMaxSize: 1000,
      memoryTtlMs: 30 * 60 * 1000,
      redisTtlSeconds: 12 * 60 * 60,
      enableL2Cache: false,
      enableStats: true,
    };

    super(repository, eventEmitter, cacheConfig, JourneyCacheService.name);
  }

  async getActiveJourneys(): Promise<CachedJourney[]> {
    const allJourneys = await this.getAll();
    return allJourneys.filter((journey) => journey.isActive);
  }

  async getJourneysByTriggerType(triggerType: string): Promise<CachedJourney[]> {
    const activeJourneys = await this.getActiveJourneys();
    return activeJourneys.filter((journey) =>
      journey.flowTriggers.some((trigger) => trigger.type === triggerType),
    );
  }

  protected getEntityName(): string {
    return 'Journey';
  }

  protected transformToCached(journey: Journey): CachedJourney {
    let flowTriggers = journey.flowTriggers;
    if (typeof flowTriggers === 'string') {
      try {
        flowTriggers = JSON.parse(flowTriggers);
      } catch (error) {
        console.warn(
          `Failed to parse flowTriggers for journey ${journey.id}:`,
          error,
        );
        flowTriggers = [];
      }
    }

    return {
      id: journey.id,
      name: journey.name,
      description: journey.description,
      isActive: journey.isActive,
      flowData: journey.flowData,
      flowTriggers: flowTriggers || [],
      variables: journey.variables || [],
      createdAt: journey.createdAt,
      updatedAt: journey.updatedAt,
      lastCached: new Date(),
    };
  }

  protected async getFromDatabase(id: string): Promise<Journey | null> {
    return this.repository.findOne({
      where: { id },
    });
  }

  protected async getMultipleFromDatabase(ids: string[]): Promise<Journey[]> {
    return this.repository.find({
      where: { id: { $in: ids } as any },
    });
  }

  protected async getAllFromDatabase(limit?: number): Promise<Journey[]> {
    const query = this.repository
      .createQueryBuilder('journey')
      .orderBy('journey.updatedAt', 'DESC');

    if (limit) {
      query.limit(limit);
    }

    return query.getMany();
  }
}
