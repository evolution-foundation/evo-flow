import { log } from '@temporalio/activity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JourneySessionCacheService } from '../../cache/services/journey-session-cache.service';
import { JourneyCacheService } from '../../cache/services/journey-cache.service';
import { Journey } from '../../journeys/entities/journey.entity';
import { JourneySession } from '../../journeys/entities/journey-session.entity';

// Interfaces for activity inputs and outputs
export interface InitializeJourneySessionInput {
  sessionId: string;
  journeyId: string;
  contactId: string;
  workflowId?: string; // The Temporal workflow ID for this session
  /**
   * Tenant the journey workflow belongs to (ADR14, story 10.1b). Propagated from
   * the workflow payload so tenant-scoped activity DB access can be wrapped via
   * `runActivityInTenantDbContext`. Optional during the single-tenant phase
   * (resolves to DEFAULT_TENANT_ID); required for multi-tenant go-live.
   */
  tenantId?: string | null;
  triggerEvent?: {
    messageId: string;
    eventName: string;
    eventType: string;
    properties: Record<string, any>;
    timestamp: string;
  };
}

export interface LoadJourneyDataInput {
  journeyId: string;
}

export interface JourneyData {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  variables?: any[];
  flowData: {
    nodes?: Array<{
      id: string;
      type: string;
      data: any;
      position: { x: number; y: number };
    }>;
    edges?: Array<{
      id: string;
      source: string;
      target: string;
      type?: string;
    }>;
  };
  flowTriggers: any[];
}

export interface FindEntryNodeInput {
  journeyData: JourneyData;
  triggerEvent?: {
    messageId: string;
    eventName: string;
    eventType: string;
    properties: Record<string, any>;
    timestamp: string;
  };
}

export interface UpdateJourneySessionInput {
  sessionId: string;
  updates: {
    currentNodeId?: string;
    status?: 'active' | 'completed' | 'failed' | 'cancelled' | 'paused';
    completedAt?: Date;
    failedAt?: Date;
    errorMessage?: string;
    variables?: Record<string, any>;
  };
}

export interface LogNodeExecutionInput {
  sessionId: string;
  nodeId: string;
  nodeType: string;
  status: 'started' | 'completed' | 'failed';
  executionTime?: number;
  result?: any;
  error?: string;
}

// Activities interface - defines the contract for all journey execution activities
export interface JourneyExecutionActivities {
  initializeJourneySession(input: InitializeJourneySessionInput): Promise<void>;
  loadJourneyData(input: LoadJourneyDataInput): Promise<JourneyData>;
  findEntryNode(
    input: FindEntryNodeInput,
  ): Promise<{ id: string; type: string; data: any } | null>;
  updateJourneySession(input: UpdateJourneySessionInput): Promise<void>;
  logNodeExecution(input: LogNodeExecutionInput): Promise<void>;
  getSessionFromCache(sessionId: string): Promise<any | null>;
  updateSessionInCache(journeySession: any): Promise<void>;
}

// Cache services instances
let journeySessionCacheService: JourneySessionCacheService;
let journeyCacheService: JourneyCacheService;

// Initialize cache services directly without DI container
async function initializeCacheServices(): Promise<void> {
  if (!journeySessionCacheService || !journeyCacheService) {
    // Import AppDataSource dynamically
    const { AppDataSource } = await import('../../../database/ormconfig');

    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }

    // Create event emitter
    const eventEmitter = new EventEmitter2();

    // Create repository instances
    const journeySessionRepository =
      AppDataSource.getRepository(JourneySession);
    const journeyRepository = AppDataSource.getRepository(Journey);

    // Create cache service instances directly
    journeySessionCacheService = new JourneySessionCacheService(
      journeySessionRepository,
      eventEmitter,
    );

    journeyCacheService = new JourneyCacheService(
      journeyRepository,
      eventEmitter,
    );
  }
}

// Implementation of activities - for now, basic structure without actual implementation
export const journeyExecutionActivities: JourneyExecutionActivities = {
  async initializeJourneySession(
    input: InitializeJourneySessionInput,
  ): Promise<void> {
    // log.info('Initializing journey session', {
    //   sessionId: input.sessionId,
    //   journeyId: input.journeyId,
    //   contactId: input.contactId,
    //   workflowId: input.workflowId,
    // });

    try {
      // Initialize cache services
      await initializeCacheServices();

      // Check if session already exists in cache
      let journeySession = await journeySessionCacheService.get(
        input.sessionId,
      );

      if (!journeySession) {
        // Load journey from cache to get initial variables and trigger
        const journey = await journeyCacheService.get(input.journeyId);

        // Initialize variables with journey defaults
        const defaultVariables: Record<string, any> = {};
        if (journey?.variables && Array.isArray(journey.variables)) {
          for (const variable of journey.variables) {
            if (variable.defaultValue !== undefined) {
              defaultVariables[variable.name] = variable.defaultValue;
            }
          }
        }

        // Create new session object for cache
        journeySession = {
          id: input.sessionId, // Set explicit ID to match workflow sessionId
          journeyId: input.journeyId,
          contactId: input.contactId,
          workflowId: input.workflowId, // Save the Temporal workflow ID
          status: 'active',
          variables: defaultVariables,
          context: {
            triggerEvent: input.triggerEvent,
            variables: {},
            metadata: {
              startedAt: new Date().toISOString(),
            },
          },
          startedAt: new Date(),
          retryCount: 0,
          maxRetries: 3,
          currentNodeId: undefined,
          waitingFor: undefined,
          workflowRunId: undefined,
          completedAt: undefined,
          failedAt: undefined,
          errorMessage: undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastCached: new Date(),
        };

        // Save in cache using cache service
        log.info('About to save session to cache', {
          sessionId: input.sessionId,
          workflowId: input.workflowId,
        });

        await journeySessionCacheService.set(journeySession as any);

        log.info('✅ Journey session created and cached', {
          sessionId: input.sessionId,
          journeyId: input.journeyId,
          contactId: input.contactId,
          workflowId: input.workflowId,
        });

        // Immediately verify the session was saved correctly
        const verifySession = await journeySessionCacheService.get(
          input.sessionId,
        );

        if (verifySession) {
          log.info('Session verification successful after creation', {
            sessionId: input.sessionId,
            hasVariables: !!verifySession.variables,
            status: verifySession.status,
            workflowId: verifySession.workflowId,
          });
        } else {
          log.error('Session verification FAILED after creation', {
            sessionId: input.sessionId,
          });
        }
      } else {
        // Session exists - ensure it has the current workflowId and is properly initialized
        let needsUpdate = false;
        
        if (!journeySession.workflowId || journeySession.workflowId !== input.workflowId) {
          journeySession.workflowId = input.workflowId;
          needsUpdate = true;
        }

        // Ensure session has proper context and trigger event
        if (!journeySession.context) {
          journeySession.context = {
            triggerEvent: input.triggerEvent,
            variables: {},
            metadata: {
              startedAt: journeySession.startedAt?.toISOString() || new Date().toISOString(),
            },
          };
          needsUpdate = true;
        }

        // Update timestamps
        journeySession.updatedAt = new Date();
        journeySession.lastCached = new Date();
        needsUpdate = true;

        if (needsUpdate) {
          // Save updated session to cache
          await journeySessionCacheService.set(journeySession as any);
          
          // log.info('Journey session updated with current workflow context', {
          //   sessionId: input.sessionId,
          //   workflowId: input.workflowId,
          //   status: journeySession.status,
          // });
        } else {
          // log.info('Journey session already properly initialized', {
          //   sessionId: input.sessionId,
          //   status: journeySession.status,
          // });
        }
      }
    } catch (error) {
      log.error('Failed to initialize journey session', {
        sessionId: input.sessionId,
        error: error.message,
      });
      throw error;
    }
  },

  async loadJourneyData(input: LoadJourneyDataInput): Promise<JourneyData> {
    // log.info('Loading journey data', {
    //   journeyId: input.journeyId,
    //   accountId: input.accountId,
    // });

    try {
      // Initialize cache services
      await initializeCacheServices();

      // Load journey from cache
      const journey = await journeyCacheService.get(input.journeyId);

      if (!journey) {
        throw new Error(`Journey ${input.journeyId} not found`);
      }

      if (!journey.isActive) {
        throw new Error(`Journey ${input.journeyId} is not active`);
      }

      // Parse JSON fields if they are strings
      let flowData = journey.flowData;
      let flowTriggers = journey.flowTriggers;

      if (typeof flowData === 'string') {
        flowData = JSON.parse(flowData);
      }
      if (typeof flowTriggers === 'string') {
        flowTriggers = JSON.parse(flowTriggers);
      }

      const journeyData: JourneyData = {
        id: journey.id,
        name: journey.name,
        description: journey.description,
        isActive: journey.isActive,
        variables: journey.variables || [],
        flowData: flowData as any,
        flowTriggers: flowTriggers as any[],
      };

      // log.info('Journey data loaded', {
      //   journeyId: input.journeyId,
      //   nodesCount: flowData?.nodes?.length || 0,
      // });

      return journeyData;
    } catch (error) {
      log.error('Failed to load journey data', {
        journeyId: input.journeyId,
        error: error.message,
      });
      throw error;
    }
  },

  async findEntryNode(
    input: FindEntryNodeInput,
  ): Promise<{ id: string; type: string; data: any } | null> {
    // log.info('Finding entry node for journey', {
    //   journeyId: input.journeyData.id,
    //   triggerEventType: input.triggerEvent?.eventType,
    //   triggerEventName: input.triggerEvent?.eventName,
    // });

    // TODO: Implement actual entry node finding logic
    // This would:
    // 1. Analyze journey flow data to find trigger nodes
    // 2. Match trigger event against node conditions
    // 3. Return the appropriate entry node

    // Look for trigger nodes or journey-trigger-node specifically
    const triggerNode = input.journeyData.flowData.nodes?.find(
      (node) =>
        node.type === 'trigger' ||
        node.type === 'journey-trigger-node' ||
        node.id === 'journey-trigger-node',
    );

    if (!triggerNode) {
      // log.warn('No trigger node found in journey', {
      //   journeyId: input.journeyData.id,
      // });
      return null;
    }

    // log.info('Entry node found', {
    //   journeyId: input.journeyData.id,
    //   nodeId: triggerNode.id,
    //   nodeType: triggerNode.type,
    // });

    return {
      id: triggerNode.id,
      type: triggerNode.type,
      data: triggerNode.data,
    };
  },

  async updateJourneySession(input: UpdateJourneySessionInput): Promise<void> {
    // log.info('Updating journey session', {
    //   sessionId: input.sessionId,
    //   updates: input.updates,
    // });

    try {
      // Initialize cache services
      await initializeCacheServices();

      // Find the session: shared Redis first, then database fallback (the
      // cache's get() falls through Redis -> DB). A session seeded externally
      // in either layer is therefore visible here — see EVO-1645.
      log.info('Searching for session in cache', {
        sessionId: input.sessionId,
      });

      const journeySession = await journeySessionCacheService.get(input.sessionId);

      log.info('Session search result', {
        sessionId: input.sessionId,
        found: !!journeySession,
        sessionStatus: journeySession?.status,
        sessionWorkflowId: journeySession?.workflowId,
      });

      if (!journeySession) {
        throw new Error(`Journey session ${input.sessionId} not found`);
      }

      // Apply updates to cached session
      if (input.updates.currentNodeId) {
        journeySession.currentNodeId = input.updates.currentNodeId;
      }

      if (input.updates.status) {
        journeySession.status = input.updates.status;

        if (input.updates.status === 'completed') {
          journeySession.completedAt = new Date();
        } else if (input.updates.status === 'failed') {
          journeySession.failedAt = new Date();
          journeySession.errorMessage =
            input.updates.errorMessage || 'Unknown error';
        }
      }

      if (input.updates.completedAt) {
        journeySession.completedAt = input.updates.completedAt;
      }

      if (input.updates.failedAt) {
        journeySession.failedAt = input.updates.failedAt;
      }

      // Update variables if provided
      if (input.updates.variables) {
        journeySession.variables = {
          ...journeySession.variables,
          ...input.updates.variables,
        };
      }

      // Update timestamps
      journeySession.updatedAt = new Date();
      journeySession.lastCached = new Date();

      // Save changes to cache
      if (input.updates.status) {
        await journeySessionCacheService.updateSessionStatus(
          input.sessionId,
          input.updates.status,
          input.updates,
        );
      } else {
        await journeySessionCacheService.set(journeySession as any);
      }

      // log.info('Journey session updated and cached successfully', {
      //   sessionId: input.sessionId,
      //   status: journeySession.status,
      //   currentNodeId: journeySession.currentNodeId,
      // });
    } catch (error) {
      log.error('Failed to update journey session', {
        sessionId: input.sessionId,
        error: error.message,
      });
      throw error;
    }
  },

  async logNodeExecution(input: LogNodeExecutionInput): Promise<void> {
    // log.info('Logging node execution', {
    //   sessionId: input.sessionId,
    //   nodeId: input.nodeId,
    //   nodeType: input.nodeType,
    //   status: input.status,
    // });

    try {
      // Initialize cache services
      await initializeCacheServices();

      // Find the session from cache
      const journeySession = await journeySessionCacheService.get(input.sessionId);

      if (!journeySession) {
        // log.warn('Journey session not found in cache for logging', {
        //   sessionId: input.sessionId,
        // });
        return;
      }

      // Add execution log to cached session
      if (!journeySession.executionLogs) {
        journeySession.executionLogs = [];
      }
      journeySession.executionLogs.push({
        nodeId: input.nodeId,
        nodeType: input.nodeType,
        status: input.status,
        timestamp: new Date(),
        executionTime: input.executionTime,
        result: input.result,
        error: input.error,
      });

      // Update timestamps
      journeySession.updatedAt = new Date();
      journeySession.lastCached = new Date();

      // Save changes to cache
      await journeySessionCacheService.set(journeySession as any);

      // 🚀 PERFORMANCE: Update cache immediately after logging execution
      try {
        await journeyExecutionActivities.updateSessionInCache(journeySession);
      } catch (cacheError) {
        log.warn('Failed to update session cache after logging execution', {
          sessionId: input.sessionId,
          nodeId: input.nodeId,
          error: cacheError.message,
        });
        // Don't fail the activity if cache update fails
      }

      // log.info('Node execution logged successfully', {
      //   sessionId: input.sessionId,
      //   nodeId: input.nodeId,
      //   status: input.status,
      // });
    } catch (error: any) {
      log.error('Failed to log node execution', {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        error: error.message,
      });
      // Don't throw error here as logging shouldn't break the workflow
    }
  },

  // 🚀 PERFORMANCE: Helper method to get session from Redis DIRECTLY (bypassing new instances)
  async getSessionFromCache(sessionId: string): Promise<any | null> {
    try {
      await initializeCacheServices();

      const result = await journeySessionCacheService.get(sessionId);

      if (result) {
        return result;
      }

      return null;
    } catch (error) {
      log.warn('Failed to get session from Redis-first approach', {
        sessionId,
        error: error.message,
      });
      return null;
    }
  },

  // 🚀 PERFORMANCE: Helper method to update session cache using cache service
  async updateSessionInCache(journeySession: any): Promise<void> {
    try {
      await initializeCacheServices();

      await journeySessionCacheService.set(journeySession);
    } catch (error) {
      log.error('Failed to update session via cache service', {
        sessionId: journeySession.id,
        error: error.message,
      });
    }
  },
};
