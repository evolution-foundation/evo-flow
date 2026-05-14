import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';
import {
  JourneySession,
  JourneySessionStatus,
} from '../entities/journey-session.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
// Bull queue removed - using Temporal timers instead
import { JourneySessionCacheService } from '../../cache/services/journey-session-cache.service';

export interface WaitRegistration {
  id: string;
  sessionId: string;
  nodeId: string;
  contactId: string;
  waitType: 'time' | 'event' | 'condition' | 'time_or_condition';
  waitConfig: any;
  expectedCompleteAt?: Date;
  fallbackAt?: Date;
  status: 'waiting' | 'completed' | 'timeout' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class WaitRegistryService {
  private readonly logger = new CustomLoggerService(WaitRegistryService.name);

  constructor(
    @InjectRepository(JourneySession)
    private readonly sessionRepository: Repository<JourneySession>,
    private readonly sessionCacheService: JourneySessionCacheService,
  ) {}

  /**
   * Register a new wait for a journey session
   */
  async registerWait(params: {
    sessionId: string;
    nodeId: string;
    contactId: string;
    waitType: 'time' | 'event' | 'condition' | 'time_or_condition';
    waitConfig: any;
  }): Promise<WaitRegistration> {
    const { sessionId, nodeId, contactId, waitType, waitConfig } = params;

    // Calculate expected completion and fallback times
    const { expectedCompleteAt, fallbackAt } = this.calculateWaitTimes(
      waitType,
      waitConfig,
    );

    // Update session with waiting status
    const updateData = {
      status: JourneySessionStatus.WAITING,
      currentNodeId: nodeId,
      waitingFor: {
        nodeId,
        waitType,
        conditions: waitConfig,
        expectedCompleteAt,
        fallbackAt,
      },
      updatedAt: new Date(),
    };
    
    await this.sessionRepository.update({ id: sessionId }, updateData);

    await this.sessionCacheService.updateSessionStatus(
      sessionId,
      JourneySessionStatus.WAITING,
      updateData,
    );

    const registration: WaitRegistration = {
      id: `${sessionId}-${nodeId}`,
      sessionId,
      nodeId,
      contactId,
      waitType,
      waitConfig,
      expectedCompleteAt,
      fallbackAt,
      status: 'waiting',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.logger.log('Wait registered', {
      sessionId,
      nodeId,
      waitType,
      expectedCompleteAt,
      fallbackAt,
    });

    return registration;
  }

  /**
   * DEPRECATED: Wait checks are now handled by Temporal timers
   * This method is kept for compatibility but does nothing
   */
  async scheduleWaitCheck(waitId: string, checkAt: Date): Promise<void> {
    this.logger.warn('scheduleWaitCheck called but Bull queues removed - using Temporal timers instead', {
      waitId,
      checkAt,
    });
  }

  /**
   * DEPRECATED: Periodic checks are now handled by Temporal activities
   * This method is kept for compatibility but does nothing
   */
  async schedulePeriodicCheck(
    waitId: string,
    sessionId: string,
    config: any,
    intervalMs: number = 60000,
  ): Promise<void> {
    this.logger.warn('schedulePeriodicCheck called but Bull queues removed - using Temporal activities instead', {
      waitId,
      sessionId,
      intervalMs,
    });
  }

  /**
   * DEPRECATED: Timeout checks are now handled by Temporal timers
   * This method is kept for compatibility but does nothing
   */
  async scheduleTimeoutCheck(waitId: string, timeoutAt: Date): Promise<void> {
    this.logger.warn('scheduleTimeoutCheck called but Bull queues removed - using Temporal timers instead', {
      waitId,
      timeoutAt,
    });
  }

  /**
   * Complete a wait (success or timeout)
   */
  async completeWait(
    sessionId: string,
    nodeId: string,
    result: 'success' | 'timeout' | 'cancelled',
  ): Promise<void> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
    });

    if (!session) {
      this.logger.warn('Session not found for wait completion', {
        sessionId,
        nodeId,
      });
      return;
    }

    // Update session status
    const updates: Partial<JourneySession> = {
      updatedAt: new Date(),
    };

    if (result === 'success' || result === 'timeout') {
      updates.status = JourneySessionStatus.ACTIVE;
      updates.waitingFor = undefined;
    } else if (result === 'cancelled') {
      updates.status = JourneySessionStatus.CANCELLED;
      updates.completedAt = new Date();
    }

    await this.sessionRepository.update({ id: sessionId }, updates);

    if (updates.status) {
      await this.sessionCacheService.updateSessionStatus(
        sessionId,
        updates.status,
        updates,
      );
    }

    // Note: Job cancellation no longer needed as Temporal handles this natively

    this.logger.log('Wait completed', {
      sessionId,
      nodeId,
      result,
    });
  }

  /**
   * Get active wait for a session
   */
  async getActiveWait(sessionId: string): Promise<WaitRegistration | null> {
    this.logger.log('Looking for active wait session', { sessionId });
    
    // 🚀 PERFORMANCE: Try cache first for known accountId
    // For getActiveWait, we'll use database directly since we need the full entity
    // TODO: Optimize this when we have account context in wait operations
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
    });
    
    this.logger.log('Session lookup result', {
      sessionId,
      sessionFound: !!session,
      sessionStatus: session?.status,
      hasWaitingFor: !!session?.waitingFor,
      waitingForNodeId: session?.waitingFor?.nodeId,
      waitingForType: session?.waitingFor?.waitType
    });

    if (!session || !session.waitingFor) {
      this.logger.warn('No active wait session found', {
        sessionId,
        sessionFound: !!session,
        hasWaitingFor: !!session?.waitingFor
      });
      return null;
    }

    return {
      id: `${sessionId}-${session.waitingFor.nodeId}`,
      sessionId,
      nodeId: session.waitingFor.nodeId,
      contactId: session.contactId,
      waitType: session.waitingFor.waitType,
      waitConfig: session.waitingFor.conditions,
      expectedCompleteAt: session.waitingFor.expectedCompleteAt,
      fallbackAt: session.waitingFor.fallbackAt,
      status: 'waiting',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  /**
   * Find active sessions for a contact
   */
  async findActiveSessions(contactId: string): Promise<JourneySession[]> {
    return this.sessionRepository.find({
      where: {
        contactId,
        status: In([JourneySessionStatus.ACTIVE, JourneySessionStatus.WAITING]),
      },
    });
  }

  /**
   * Check if contact has active non-waiting sessions using cache
   */
  async hasActiveNonWaitingSession(contactId: string): Promise<boolean> {
    const contactSessions =
      await this.sessionCacheService.getSessionsByContact(contactId);

    return contactSessions.some(
      (session) =>
        session.status === JourneySessionStatus.ACTIVE &&
        !session.waitingFor,
    );
  }

  /**
   * Check if contact already has an active or waiting session for specific journey using cache
   */
  async hasExistingJourneySession(
    contactId: string,
    journeyId: string,
  ): Promise<boolean> {
    const contactSessions =
      await this.sessionCacheService.getSessionsByContact(contactId);

    // Check if any session is for this journey and in active/waiting/paused status
    return contactSessions.some(
      (session) =>
        session.journeyId === journeyId &&
        (session.status === JourneySessionStatus.ACTIVE ||
          session.status === JourneySessionStatus.WAITING ||
          session.status === JourneySessionStatus.PAUSED),
    );
  }

  /**
   * Calculate wait times based on configuration
   */
  private calculateWaitTimes(
    waitType: string,
    config: any,
  ): {
    expectedCompleteAt?: Date;
    fallbackAt?: Date;
  } {
    const now = Date.now();
    let expectedCompleteAt: Date | undefined;
    let fallbackAt: Date | undefined;

    switch (waitType) {
      case 'time':
        const duration = config.duration || 1;
        const unit = config.timeUnit || 'minutes';
        const ms = this.convertToMs(duration, unit);
        expectedCompleteAt = new Date(now + ms);
        break;

      case 'event':
      case 'condition':
        if (config.enableFallback && config.fallbackTime) {
          const fallbackMs = this.convertToMs(
            config.fallbackTime,
            config.fallbackUnit || 'hours',
          );
          fallbackAt = new Date(now + fallbackMs);
        }
        break;

      case 'time_or_condition':
        const maxTime = config.maxWaitTime || 1;
        const maxUnit = config.maxWaitUnit || 'hours';
        const maxMs = this.convertToMs(maxTime, maxUnit);
        expectedCompleteAt = new Date(now + maxMs);
        break;
    }

    return { expectedCompleteAt, fallbackAt };
  }

  /**
   * Convert time to milliseconds
   */
  private convertToMs(value: number, unit: string): number {
    switch (unit) {
      case 'minutes':
        return value * 60 * 1000;
      case 'hours':
        return value * 60 * 60 * 1000;
      case 'days':
        return value * 24 * 60 * 60 * 1000;
      default:
        return value * 60 * 1000; // Default to minutes
    }
  }
}

// Add missing imports for TypeORM operators
