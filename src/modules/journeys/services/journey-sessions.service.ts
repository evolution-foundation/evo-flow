import { Injectable, NotFoundException } from '@nestjs/common';
import { JourneySessionStatus } from '../entities/journey-session.entity';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { JourneySessionCacheService, CachedJourneySession } from '../../cache/services/journey-session-cache.service';
import { Client, Connection } from '@temporalio/client';
import { randomUUID } from 'crypto';

export interface StartJourneyTriggerEvent {
  messageId: string;
  eventName: string;
  eventType: string;
  properties: Record<string, any>;
  timestamp: string;
}

export interface StartJourneyResult {
  started: boolean;
  sessionId?: string;
  workflowId?: string;
  reason?: string;
}

const DEFAULT_SESSION_MAX_RETRIES = 3;

export interface SessionFilters {
  status?: string;
  contactId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface SessionListResponse {
  sessions: CachedJourneySession[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class JourneySessionsService {
  private readonly logger: CustomLoggerService;
  private temporalClient: Client | null = null;

  constructor(
    private readonly sessionCacheService: JourneySessionCacheService,
  ) {
    this.logger = new CustomLoggerService(JourneySessionsService.name);
  }

  private async getTemporalClient(): Promise<Client> {
    if (!this.temporalClient) {
      const connection = await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      });

      this.temporalClient = new Client({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      });
    }

    return this.temporalClient;
  }

  /**
   * Create a journey session and start its Temporal workflow for a contact.
   *
   * The session is persisted to the cache BEFORE the workflow starts: the
   * workflow's first `updateJourneySession` reads the session and throws if it
   * is absent, and `updateSessionStatus` is a no-op when the session does not
   * yet exist — so without this explicit create the workflow can never advance.
   *
   * Used by the manual trigger endpoint (`POST /journeys/trigger/:id`), which
   * targets a specific journey directly rather than relying on event matching.
   */
  async startJourney(
    journey: { id: string; name?: string },
    contactId: string,
    triggerEvent: StartJourneyTriggerEvent,
    options: { enforceActiveSessionGuard?: boolean } = {},
  ): Promise<StartJourneyResult> {
    const { enforceActiveSessionGuard = true } = options;

    if (enforceActiveSessionGuard) {
      const contactSessions =
        await this.sessionCacheService.getSessionsByContact(contactId);
      // Scoped to THIS journey: a session in a different journey must not block
      // this one. A dangling/active session therefore only blocks re-entry into
      // the same journey, not every journey for the contact (EVO-1691).
      const hasActiveOrWaiting = contactSessions.some(
        (session) =>
          session.journeyId === journey.id &&
          ((session.status as JourneySessionStatus) ===
            JourneySessionStatus.ACTIVE ||
            (session.status as JourneySessionStatus) ===
              JourneySessionStatus.WAITING),
      );

      if (hasActiveOrWaiting) {
        this.logger.warn(
          'Blocking journey start — contact already has an active/waiting session for this journey',
          { contactId, journeyId: journey.id },
        );
        return { started: false, reason: 'contact_has_active_session' };
      }
    }

    const sessionId = randomUUID();
    const workflowId = `journey-${journey.id}-contact-${contactId}-${Date.now()}`;
    const now = new Date();

    await this.sessionCacheService.set({
      id: sessionId,
      journeyId: journey.id,
      contactId,
      status: JourneySessionStatus.ACTIVE,
      variables: {},
      retryCount: 0,
      maxRetries: DEFAULT_SESSION_MAX_RETRIES,
      executionLogs: [],
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      lastCached: now,
    } as any);

    const { JourneyExecutionWorkflow } = await import(
      '../../temporal/workflows/journey-execution.workflow'
    );
    const client = await this.getTemporalClient();

    const handle = await client.workflow
      .start(JourneyExecutionWorkflow, {
        taskQueue: 'journey-execution',
        workflowId,
        args: [{ sessionId, journeyId: journey.id, contactId, triggerEvent }],
        workflowExecutionTimeout: '30d',
        workflowTaskTimeout: '1m',
      })
      .catch(async (error) => {
        // Roll back the session created above: a failed start must not leave a
        // phantom ACTIVE session that blocks future triggers for this contact.
        await this.sessionCacheService.invalidate(sessionId);
        throw error;
      });

    await this.sessionCacheService.updateSessionStatus(
      sessionId,
      JourneySessionStatus.ACTIVE,
      { workflowId, workflowRunId: handle.firstExecutionRunId },
    );

    this.logger.log('Journey workflow started via manual trigger', {
      journeyId: journey.id,
      journeyName: journey.name,
      contactId,
      sessionId,
      workflowId,
      runId: handle.firstExecutionRunId,
    });

    return { started: true, sessionId, workflowId };
  }

  /**
   * List all sessions for a journey with optional filters from Redis cache
   */
  async findByJourneyId(
    journeyId: string,
    filters?: SessionFilters,
    page: number = 1,
    pageSize: number = 50,
  ): Promise<SessionListResponse> {
    this.logger.debug('Finding sessions for journey from cache', {
      journeyId,
      filters,
      page,
      pageSize,
    });

    const allSessions = await this.sessionCacheService.getAll();

    let filteredSessions = allSessions.filter(
      (session) => session.journeyId === journeyId,
    );

    this.logger.debug('Filtered sessions by journey', {
      journeyId,
      totalSessions: allSessions.length,
      journeySessions: filteredSessions.length,
    });

    if (filters?.status) {
      filteredSessions = filteredSessions.filter(
        (session) => session.status === filters.status,
      );
    }

    if (filters?.contactId) {
      filteredSessions = filteredSessions.filter(
        (session) => session.contactId === filters.contactId,
      );
    }

    if (filters?.startDate) {
      filteredSessions = filteredSessions.filter(
        (session) =>
          new Date(session.createdAt) >= filters.startDate!,
      );
    }

    if (filters?.endDate) {
      filteredSessions = filteredSessions.filter(
        (session) =>
          new Date(session.createdAt) <= filters.endDate!,
      );
    }

    filteredSessions.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = filteredSessions.length;

    const startIndex = (page - 1) * pageSize;
    const paginatedSessions = filteredSessions.slice(
      startIndex,
      startIndex + pageSize,
    );

    this.logger.log('Sessions retrieved from cache', {
      journeyId,
      total,
      page,
      pageSize,
      returned: paginatedSessions.length,
    });

    return {
      sessions: paginatedSessions,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get a specific session by ID from cache
   */
  async findOne(
    sessionId: string,
    journeyId: string,
  ): Promise<CachedJourneySession> {
    const session = await this.sessionCacheService.get(sessionId);

    if (!session || session.journeyId !== journeyId) {
      throw new NotFoundException(
        `Session with ID ${sessionId} not found for journey ${journeyId}`,
      );
    }

    return session;
  }

  /**
   * Delete a session from cache and cancel workflow
   */
  async remove(sessionId: string, journeyId: string): Promise<void> {
    const session = await this.findOne(sessionId, journeyId);

    this.logger.log('Deleting journey session', {
      sessionId,
      journeyId,
      status: session.status,
      workflowId: session.workflowId,
    });

    if (
      (session.status === 'active' || session.status === 'waiting') &&
      session.workflowId
    ) {
      try {
        const client = await this.getTemporalClient();
        const handle = client.workflow.getHandle(session.workflowId);
        await handle.cancel();
        this.logger.log('Temporal workflow cancelled', {
          sessionId,
          workflowId: session.workflowId,
        });
      } catch (error) {
        this.logger.warn('Failed to cancel Temporal workflow', {
          sessionId,
          workflowId: session.workflowId,
          error: error.message,
        });
      }
    }

    await this.sessionCacheService.invalidate(sessionId);
  }

  /**
   * Cancel an active session by sending signal to Temporal workflow
   */
  async cancel(
    sessionId: string,
    journeyId: string,
  ): Promise<CachedJourneySession> {
    const session = await this.findOne(sessionId, journeyId);

    if (session.status !== 'active' && session.status !== 'waiting') {
      throw new Error(
        `Cannot cancel session in ${session.status} status. Only active or waiting sessions can be cancelled.`,
      );
    }

    this.logger.log('Cancelling journey session', {
      sessionId,
      journeyId,
      previousStatus: session.status,
      workflowId: session.workflowId,
    });

    if (session.workflowId) {
      try {
        const client = await this.getTemporalClient();
        const handle = client.workflow.getHandle(session.workflowId);
        await handle.signal('cancelJourney');
        this.logger.log('Cancel signal sent to Temporal workflow', {
          sessionId,
          workflowId: session.workflowId,
        });
      } catch (error) {
        this.logger.error('Failed to send cancel signal to workflow', {
          sessionId,
          workflowId: session.workflowId,
          error: error.message,
        });
        throw new Error(`Failed to cancel workflow: ${error.message}`);
      }
    }

    await this.sessionCacheService.updateSessionStatus(
      sessionId,
      'cancelled',
      {
        completedAt: new Date(),
      },
    );

    const updatedSession = await this.sessionCacheService.get(sessionId);
    if (!updatedSession) {
      throw new NotFoundException('Session not found after cancellation');
    }

    return updatedSession;
  }

  /**
   * Get session statistics for a journey from cache
   */
  async getStats(journeyId: string) {
    const allSessions = await this.sessionCacheService.getAll();
    const journeySessions = allSessions.filter(
      (session) => session.journeyId === journeyId,
    );

    const stats = {
      total: journeySessions.length,
      byStatus: {
        active: 0,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    };

    for (const session of journeySessions) {
      const status = session.status.toLowerCase();
      if (status in stats.byStatus) {
        stats.byStatus[status]++;
      }
    }

    this.logger.debug('Journey session stats retrieved', {
      journeyId,
      stats,
    });

    return stats;
  }

  /**
   * Bulk delete sessions by status from cache
   */
  async bulkDeleteByStatus(
    journeyId: string,
    status: string,
  ): Promise<number> {
    this.logger.log('Bulk deleting sessions by status', {
      journeyId,
      status,
    });

    const allSessions = await this.sessionCacheService.getAll();
    const sessionsToDelete = allSessions.filter(
      (session) =>
        session.journeyId === journeyId && session.status === status,
    );

    let deletedCount = 0;

    for (const session of sessionsToDelete) {
      try {
        if (
          (session.status === 'active' || session.status === 'waiting') &&
          session.workflowId
        ) {
          try {
            const client = await this.getTemporalClient();
            const handle = client.workflow.getHandle(session.workflowId);
            await handle.cancel();
          } catch (error) {
            this.logger.warn('Failed to cancel workflow during bulk delete', {
              sessionId: session.id,
              workflowId: session.workflowId,
              error: error.message,
            });
          }
        }

        await this.sessionCacheService.invalidate(session.id);
        deletedCount++;
      } catch (error) {
        this.logger.error('Failed to delete session during bulk operation', {
          sessionId: session.id,
          error: error.message,
        });
      }
    }

    this.logger.log('Bulk delete completed', {
      journeyId,
      status,
      deletedCount,
    });

    return deletedCount;
  }
}
