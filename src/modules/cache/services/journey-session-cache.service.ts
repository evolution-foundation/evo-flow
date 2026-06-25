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

  // EVO-1756: write-through to Postgres so session history is durable and
  // survives a Redis flush/TTL. Every write path (create, status transitions,
  // per-node updates) funnels through set(), so overriding it here makes the
  // whole lifecycle durable. The read path already falls back to the DB on a
  // cache miss (BaseCacheService.get/getAll), so no read change is needed.
  // Redis is written first (hot path); the DB write follows and its failure
  // propagates so the Temporal activity retries / create fails loudly rather
  // than silently dropping the record.
  async set(entity: JourneySession): Promise<void> {
    await super.set(entity);
    await this.persistToDatabase(entity);
  }

  private async persistToDatabase(value: JourneySession): Promise<void> {
    const v = value as unknown as CachedJourneySession;
    try {
      await this.repository.save({
        id: v.id,
        journeyId: v.journeyId,
        contactId: v.contactId,
        status: v.status as JourneySession['status'],
        currentNodeId: v.currentNodeId,
        waitingFor: v.waitingFor,
        variables: v.variables ?? {},
        workflowId: v.workflowId,
        workflowRunId: v.workflowRunId,
        startedAt: v.startedAt,
        completedAt: v.completedAt,
        failedAt: v.failedAt,
        errorMessage: v.errorMessage,
        context: v.context,
        retryCount: v.retryCount ?? 0,
        maxRetries: v.maxRetries ?? 3,
        executionLogs: v.executionLogs ?? [],
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist journey session ${v.id} to Postgres: ${error.message}`,
      );
      throw error;
    }
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
      this.logger.error(
        `Failed to get sessions by contact ${contactId}: ${error.message}`,
      );
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

  /**
   * Create-or-overwrite a session row in the terminal `failed` state when a
   * journey could not be dispatched (EVO-1764). The normal failure path goes
   * through a worker activity that has already created the row, so it can use
   * `updateSessionStatus`; the dispatch guard runs when there is *no* worker, so
   * the row does not exist yet and an update-only write would silently no-op.
   * This goes through `set()` (Redis + Postgres write-through), making the
   * failed-to-dispatch journey durable and visible instead of vanishing.
   */
  async createFailedDispatchSession(params: {
    sessionId: string;
    journeyId: string;
    contactId: string;
    workflowId?: string;
    workflowRunId?: string;
    errorMessage: string;
  }): Promise<void> {
    const now = new Date();
    await this.set({
      id: params.sessionId,
      journeyId: params.journeyId,
      contactId: params.contactId,
      status: 'failed',
      workflowId: params.workflowId,
      workflowRunId: params.workflowRunId,
      failedAt: now,
      errorMessage: params.errorMessage,
      variables: {},
      retryCount: 0,
      maxRetries: 3,
      executionLogs: [],
      createdAt: now,
      updatedAt: now,
      lastCached: now,
    } as unknown as JourneySession);

    this.eventEmitter.emit('journey-session.status-updated', {
      id: params.sessionId,
      status: 'failed',
      errorMessage: params.errorMessage,
    });
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

  protected async getMultipleFromDatabase(
    ids: string[],
  ): Promise<JourneySession[]> {
    return this.repository.find({
      where: { id: In(ids) },
    });
  }

  protected async getAllFromDatabase(
    limit?: number,
  ): Promise<JourneySession[]> {
    const query = this.repository
      .createQueryBuilder('session')
      .orderBy('session.updatedAt', 'DESC');

    if (limit) {
      query.limit(limit);
    }

    return query.getMany();
  }

  // EVO-1896: idempotency guard keyed by (journey, contact, messageId).
  //
  // The EVO-1691 active/waiting-session guard only blocks *concurrent*
  // re-entry into the same journey; once a session reaches a terminal state
  // (completed/failed) it no longer blocks. Kafka delivers at-least-once, so a
  // redelivery of the SAME trigger event after the first run has finished slips
  // past that guard and starts a second session — running every side effect
  // (messages, pipeline moves, …) twice. We dedup on the messageId, which is
  // the producer-stable identity of a trigger event, so a replay of the exact
  // same event is dropped while genuinely distinct events (different messageId)
  // still start fresh runs.
  //
  // The check is a single atomic `SET key flag NX EX ttl`: NX makes the very
  // first caller win even under concurrent redelivery across consumers/replicas
  // (it's a CAS, not a read-then-write), and the TTL bounds the dedup window so
  // the keyspace self-cleans. Returns true when THIS call claimed the messageId
  // (i.e. it is the first to process it → proceed with startJourney), false
  // when it was already claimed (→ skip, it's a replay).
  private buildDedupKey(
    journeyId: string,
    contactId: string,
    messageId: string,
  ): string {
    return `evo-campaign:journey:dedup:${journeyId}:${contactId}:${messageId}`;
  }

  /**
   * Atomically claim a trigger (journey, contact, messageId) for execution.
   * - Returns `true` if this is the first time we see the messageId for this
   *   journey/contact → caller should proceed with startJourney.
   * - Returns `false` if it was already claimed within the TTL window → caller
   *   should skip (Kafka at-least-once replay / retry).
   *
   * Fail-open: if Redis is unavailable we return `true` so a transient cache
   * outage never silently swallows legitimate triggers — at worst we lose the
   * dedup protection for that window, which degrades back to today's behaviour
   * rather than dropping the journey entirely.
   */
  async tryClaimTriggerMessage(
    journeyId: string,
    contactId: string,
    messageId: string,
    ttlSeconds: number = 24 * 60 * 60,
  ): Promise<boolean> {
    try {
      await this.ensureRedisConnected();
      const key = this.buildDedupKey(journeyId, contactId, messageId);
      // ioredis: SET key value EX <ttl> NX → returns 'OK' if set, null if it
      // already existed. Atomic compare-and-set, safe under concurrency.
      const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.warn(
        `Trigger dedup check failed for journey ${journeyId} contact ${contactId} message ${messageId}, allowing execution: ${error.message}`,
      );
      return true;
    }
  }

  // Waiting index helpers (Redis set per contact)
  private buildWaitingIndexKey(contactId: string): string {
    return `evo-campaign:journey-session:waiting:${contactId}`;
  }

  async addToWaitingIndex(sessionId: string, contactId: string): Promise<void> {
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
