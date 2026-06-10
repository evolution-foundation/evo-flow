import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JourneySession } from '../../journeys/entities/journey-session.entity';
import { BaseCacheService } from './base-cache.service';
import { CacheConfig } from '../interfaces/cache.interfaces';

export interface CachedJourneySession {
  id: string;
  journeyId: string;
  contactId: string;
  status: string;
  currentNodeId?: string;
  context?: any;
  waitingFor?: any;
  variables?: Record<string, any>;
  workflowId?: string;
  workflowRunId?: string;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
  executionLogs?: Array<{
    nodeId: string;
    nodeType: string;
    status: 'started' | 'completed' | 'failed';
    timestamp: Date;
    executionTime?: number;
    result?: any;
    error?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
}

@Injectable()
export class JourneySessionCacheService extends BaseCacheService<
  JourneySession,
  CachedJourneySession
> {
  constructor(
    @InjectRepository(JourneySession)
    repository: Repository<JourneySession>,
    eventEmitter: EventEmitter2,
  ) {
    // EVO-1645: sessions ARE shared across instances. In BaseCacheService's
    // (inverted vs. convention) naming, L1 = Redis (always on, shared) and
    // L2 = per-instance in-memory LRU. `enableL2Cache: false` only disables
    // the local memory layer — deliberately, because a per-instance LRU would
    // serve stale session state when the journey worker runs >1 replica.
    // Reads go Redis -> database, so a session can be seeded externally
    // (E2E/QA) either by writing the Redis key
    // `evo-campaign:journey-session:<id>` (+ the `:index` set) or by inserting
    // a journey_sessions row — see src/modules/journeys/README.md.
    const cacheConfig: CacheConfig = {
      redisKeyPrefix: 'evo-campaign:journey-session',
      memoryMaxSize: 2000,
      memoryTtlMs: 60 * 60 * 1000,
      redisTtlSeconds: 24 * 60 * 60,
      enableL2Cache: false,
      enableStats: true,
    };

    super(
      repository,
      eventEmitter,
      cacheConfig,
      JourneySessionCacheService.name,
    );
  }

  async getActiveSessionsByJourney(
    journeyId: string,
  ): Promise<CachedJourneySession[]> {
    const allSessions = await this.getAll();
    return allSessions.filter(
      (session) =>
        session.journeyId === journeyId && session.status === 'active',
    );
  }

  async getSessionsByContact(
    contactId: string,
  ): Promise<CachedJourneySession[]> {
    try {
      const allSessions = await this.getAll();
      return allSessions.filter((session) => session.contactId === contactId);
    } catch (error) {
      this.logger.error(`Failed to get sessions by contact ${contactId}: ${error.message}`);
      throw error;
    }
  }

  async getSessionByWorkflowId(
    workflowId: string,
  ): Promise<CachedJourneySession | null> {
    const allSessions = await this.getAll();
    return (
      allSessions.find((session) => session.workflowId === workflowId) || null
    );
  }

  async updateSessionStatus(
    sessionId: string,
    status: string,
    additionalData?: Partial<CachedJourneySession>,
  ): Promise<void> {
    const session = await this.get(sessionId);
    if (session) {
      const updated = {
        ...session,
        status,
        ...additionalData,
        updatedAt: new Date(),
        lastCached: new Date(),
      };

      await this.set({
        ...updated,
        id: sessionId,
      } as any);

      try {
        if (status === 'WAITING' || status === 'waiting') {
          await this.addToWaitingIndex(sessionId, session.contactId);
        } else {
          await this.removeFromWaitingIndex(sessionId, session.contactId);
        }
      } catch (e) {
        // Ignore index errors
      }

      this.eventEmitter.emit('journey-session.status-updated', {
        id: sessionId,
        status,
        ...additionalData,
      });
    }
  }

  protected getEntityName(): string {
    return 'JourneySession';
  }

  protected transformToCached(session: JourneySession): CachedJourneySession {
    return {
      id: session.id,
      journeyId: session.journeyId,
      contactId: session.contactId,
      status: session.status,
      currentNodeId: session.currentNodeId,
      context: session.context,
      waitingFor: (session as any).waitingFor,
      variables: session.variables || {},
      workflowId: session.workflowId,
      workflowRunId: session.workflowRunId,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      failedAt: session.failedAt,
      errorMessage: session.errorMessage,
      retryCount: session.retryCount,
      maxRetries: session.maxRetries,
      executionLogs: session.executionLogs || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastCached: new Date(),
    };
  }

  protected async getFromDatabase(id: string): Promise<JourneySession | null> {
    return this.repository.findOne({
      where: { id },
    });
  }

  protected async getMultipleFromDatabase(ids: string[]): Promise<JourneySession[]> {
    return this.repository.find({
      where: { id: In(ids) },
    });
  }

  protected async getAllFromDatabase(limit?: number): Promise<JourneySession[]> {
    const query = this.repository
      .createQueryBuilder('session')
      .orderBy('session.updatedAt', 'DESC');

    if (limit) {
      query.limit(limit);
    }

    return query.getMany();
  }

  // Waiting index helpers (Redis set per contact)
  private buildWaitingIndexKey(contactId: string): string {
    return `evo-campaign:journey-session:waiting:${contactId}`;
  }

  async addToWaitingIndex(
    sessionId: string,
    contactId: string,
  ): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') {
      await this.redis.connect();
    }
    const key = this.buildWaitingIndexKey(contactId);
    await this.redis.sadd(key, sessionId);
  }

  async removeFromWaitingIndex(
    sessionId: string,
    contactId: string,
  ): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') {
      await this.redis.connect();
    }
    const key = this.buildWaitingIndexKey(contactId);
    await this.redis.srem(key, sessionId);
  }

  async getWaitingSessionIdsByContact(contactId: string): Promise<string[]> {
    if (!this.redis || this.redis.status !== 'ready') {
      await this.redis.connect();
    }
    const key = this.buildWaitingIndexKey(contactId);
    const ids = await this.redis.smembers(key);
    return ids || [];
  }

  async getWaitingSessionsByContact(
    contactId: string,
  ): Promise<CachedJourneySession[]> {
    const ids = await this.getWaitingSessionIdsByContact(contactId);
    if (!ids.length) return [];
    return await this.getMultiple(ids);
  }
}
