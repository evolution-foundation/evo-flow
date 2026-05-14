import { log } from '@temporalio/activity';

// Interfaces for wait activity inputs and outputs
export interface RegisterWaitInput {
  sessionId: string;
  nodeId: string;
  contactId: string;
  waitType: 'time' | 'event' | 'condition' | 'time_or_condition';
  waitConfig: any;
}

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

export interface CompleteWaitInput {
  sessionId: string;
  nodeId: string;
  result: 'success' | 'timeout' | 'cancelled';
}

// Activities interface - defines the contract for all wait activities
export interface WaitActivities {
  registerWait(input: RegisterWaitInput): Promise<WaitRegistration>;
  completeWait(input: CompleteWaitInput): Promise<void>;
  getActiveWait(sessionId: string): Promise<WaitRegistration | null>;
}

// Create wait registry service that uses Redis cache
let waitRegistryServiceCache: any = null;

async function createWaitRegistryService() {
  if (waitRegistryServiceCache) {
    return waitRegistryServiceCache;
  }

  try {
    // Import required modules
    const { AppDataSource } = await import('../../../database/ormconfig');
    const { WaitRegistryService } = await import('../../journeys/services/wait-registry.service');
    const { JourneySessionCacheService } = await import('../../cache/services/journey-session-cache.service');
    const { JourneySession } = await import('../../journeys/entities/journey-session.entity');

    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }

    const sessionRepository = AppDataSource.getRepository(JourneySession);
    
    // Create a mock event emitter for the cache service
    const mockEventEmitter = {
      emit: () => {},
      on: () => {},
      off: () => {},
      once: () => {},
    };
    
    const sessionCacheService = new JourneySessionCacheService(
      sessionRepository,
      mockEventEmitter as any,
    );
    
    waitRegistryServiceCache = new WaitRegistryService(
      sessionRepository,
      sessionCacheService,
    );

    log.info('Wait registry service initialized with Redis cache');
    return waitRegistryServiceCache;
  } catch (error: any) {
    log.error('Failed to create wait registry service', {
      error: error.message,
    });
    throw error;
  }
}

// Implementation of activities - Using WaitRegistryService with Redis cache
export const waitActivities: WaitActivities = {
  async registerWait(input: RegisterWaitInput): Promise<WaitRegistration> {
    log.info('Registering wait', {
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      waitType: input.waitType,
    });

    try {
      const waitRegistryService = await createWaitRegistryService();
      
      const registration = await waitRegistryService.registerWait({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        contactId: input.contactId,
        waitType: input.waitType,
        waitConfig: input.waitConfig,
      });

      log.info('Wait registered successfully using Redis cache', {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        waitId: registration.id,
        expectedCompleteAt: registration.expectedCompleteAt,
        fallbackAt: registration.fallbackAt,
      });

      return registration;
    } catch (error: any) {
      log.error('Failed to register wait', {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        error: error.message,
      });
      throw error;
    }
  },

  async completeWait(input: CompleteWaitInput): Promise<void> {
    log.info('Completing wait', {
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      result: input.result,
    });

    try {
      const waitRegistryService = await createWaitRegistryService();
      
      await waitRegistryService.completeWait(
        input.sessionId,
        input.nodeId,
        input.result
      );

      log.info('Wait completed successfully using Redis cache', {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        result: input.result,
      });
    } catch (error: any) {
      log.error('Failed to complete wait', {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        error: error.message,
      });
      throw error;
    }
  },

  async getActiveWait(sessionId: string): Promise<WaitRegistration | null> {
    log.info('Getting active wait', { sessionId });

    try {
      const waitRegistryService = await createWaitRegistryService();
      
      const activeWait = await waitRegistryService.getActiveWait(sessionId);

      log.info('Active wait retrieved using Redis cache', {
        sessionId,
        found: !!activeWait,
        waitId: activeWait?.id,
      });

      return activeWait;
    } catch (error: any) {
      log.error('Failed to get active wait', {
        sessionId,
        error: error.message,
      });
      throw error;
    }
  },
};
