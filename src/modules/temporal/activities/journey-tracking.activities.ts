import { log } from '@temporalio/activity';
import {
  JourneyTrackingService,
  JourneyTrackingContext,
  NodeExecutionTracking,
} from '../services/journey-tracking.service';
import type { EventData } from '../../processing/interfaces/event-data.interface';

// Activities interface for journey tracking
export interface JourneyTrackingActivities {
  trackJourneyStarted(
    context: JourneyTrackingContext,
    triggerEvent?: any,
  ): Promise<void>;
  trackJourneyCompleted(
    context: JourneyTrackingContext,
    completionData: {
      completedNodes: string[];
      totalExecutionTime: number;
      finalStatus: string;
    },
  ): Promise<void>;
  trackJourneyFailed(
    context: JourneyTrackingContext,
    failureData: {
      error: string;
      failedNodeId?: string;
      completedNodes: string[];
    },
  ): Promise<void>;
  trackNodeExecution(
    context: JourneyTrackingContext,
    tracking: NodeExecutionTracking,
  ): Promise<void>;
  trackNodeTransition(
    context: JourneyTrackingContext,
    transition: {
      fromNodeId: string;
      fromNodeType: string;
      toNodeId: string;
      toNodeType: string;
      handle?: string;
      transitionReason?: string;
    },
  ): Promise<void>;
  trackConditionalEvaluation(
    context: JourneyTrackingContext,
    evaluation: {
      nodeId: string;
      paths: Array<{
        pathId: string;
        pathName: string;
        conditions: any[];
        matched: boolean;
        evaluationTime: number;
      }>;
      selectedPath: string;
      selectedPathName: string;
    },
  ): Promise<void>;
  trackWaitEvent(
    context: JourneyTrackingContext,
    waitEvent: {
      nodeId: string;
      waitType: string;
      action: 'started' | 'completed' | 'timeout' | 'cancelled';
      waitDuration?: number;
      expectedDuration?: number;
      completionTrigger?: string;
    },
  ): Promise<void>;
}

// Singleton instances cache
let trackingServiceCache: JourneyTrackingService | null = null;

// Cached Kafka service instance. Only populated once the producer is confirmed
// connected — a half-initialized instance must never be cached (EVO-1894).
let kafkaServiceCache: any = null;

// When Kafka cannot be initialized/connected (e.g. broker down in the single /
// temporal-worker process), tracking degrades silently: events become no-ops
// instead of throwing "Kafka producer not initialized" on every node, which
// previously flooded the logs with ERROR and masked other failures (EVO-1894).
let trackingDisabled = false;

/**
 * Ensure the cached KafkaService has a connected producer.
 * Returns true when tracking can be sent, false when it should degrade silently.
 * Caching the instance only after a successful connect prevents a failed init
 * from leaving a producer-less KafkaService cached and emitting per-event errors.
 */
async function ensureKafkaService(): Promise<boolean> {
  if (kafkaServiceCache) {
    return true;
  }
  if (trackingDisabled) {
    return false;
  }

  const { KafkaService } = await import('../../processing/kafka/kafka.service');

  const kafkaService = new KafkaService();
  try {
    // Initialize Kafka (admin + producer). onModuleInit honors the processing
    // config; in single / temporal-worker mode the defaults select Kafka.
    await kafkaService.onModuleInit();

    // Confirm the producer actually connected before caching — onModuleInit can
    // skip init (config) or fail mid-way and still leave the instance usable as
    // a constructed object whose sendEvent() would throw "producer not
    // initialized" on every call.
    const status = await kafkaService.getStatus();
    if (!status?.connected) {
      throw new Error('Kafka producer not connected after initialization');
    }

    kafkaServiceCache = kafkaService;
    log.info('Kafka service initialized for journey tracking');
    return true;
  } catch (error: any) {
    // Degrade once, loudly, then stay quiet for the rest of the process lifetime.
    trackingDisabled = true;
    log.warn(
      'Journey tracking disabled: Kafka producer unavailable. ' +
        'Tracking events will be skipped (no analytics) for this process.',
      { error: error.message },
    );
    return false;
  }
}

// Create tracking service that sends events to Kafka (same pattern as events.service)
async function createTrackingService(): Promise<JourneyTrackingService> {
  // Return cached instance if already created
  if (trackingServiceCache) {
    return trackingServiceCache;
  }

  try {
    // Import required modules
    const { getProcessingConfig } = await import('../../processing/config/processing.config');

    // Check if we're in Kafka mode
    const config = getProcessingConfig();
    log.info('Journey tracking config', {
      queueMode: config.queueMode,
      writeMode: config.writeMode,
      kafkaTopic: config.kafka?.topic,
    });

    // Initialize (and validate) the Kafka producer. When unavailable, tracking
    // degrades to no-op instead of spamming ERROR on every event.
    const kafkaReady = await ensureKafkaService();

    // Create a minimal ProcessingService-like wrapper that sends to Kafka
    const processingServiceLike = {
      async processEvent(eventData: EventData) {
        // Tracking is degraded (Kafka unavailable in this process): skip
        // silently so journey execution stays clean of per-event ERROR noise.
        if (!kafkaReady || !kafkaServiceCache) {
          return {
            messageId: eventData.messageId,
            status: 'success' as const,
          };
        }
        try {
          log.info('About to send journey tracking event to Kafka', {
            messageId: eventData.messageId,
            eventName: eventData.eventName,
            eventType: eventData.eventType,
            contactId: eventData.contactId,
          });
          
          // Build Kafka payload in EXACT same format as KafkaQueueProcessor for ClickHouse Kafka Engine
          const now = new Date();
          const occurredAt = eventData.timestamp
            ? new Date(eventData.timestamp)
            : now;

          const kafkaPayload = {
            // Core fields for ClickHouse (EXACT format from KafkaQueueProcessor)
            event_type: eventData.eventType,
            event_name: eventData.eventName || eventData.eventType,

            // JSON fields
            properties: eventData.properties || {},
            traits: eventData.traits || {},
            context: eventData.context || {},

            // Identifiers
            contact_id: eventData.contactId,
            anonymous_id: eventData.anonymousId,
            message_id: eventData.messageId,

            // Timestamps
            occurred_at: occurredAt.toISOString(),
            processing_time: now.toISOString(),

            // Full message for debugging
            message_raw: {
              type: eventData.eventType,
              eventName: eventData.eventName,
              properties: eventData.properties,
              traits: eventData.traits,
              timestamp: eventData.timestamp,
              contactId: eventData.contactId,
              anonymousId: eventData.anonymousId,
              context: eventData.context,
              messageId: eventData.messageId,
            },
          };
          
          // Send structured payload to Kafka (matches KafkaQueueProcessor format)
          await kafkaServiceCache.sendEvent(kafkaPayload);
          
          log.info('✅ Journey tracking event SENT to Kafka successfully', {
            messageId: eventData.messageId,
            eventName: eventData.eventName,
            eventType: eventData.eventType,
          });
          
          return {
            messageId: eventData.messageId,
            status: 'success' as const,
          };
        } catch (error: any) {
          log.error('❌ Failed to send journey tracking event to Kafka', {
            messageId: eventData.messageId,
            eventName: eventData.eventName,
            error: error.message,
            stack: error.stack,
          });
          return {
            messageId: eventData.messageId,
            status: 'error' as const,
            error: error.message,
          };
        }
      },
    };

    // Create and cache the JourneyTrackingService with processing service
    trackingServiceCache = new JourneyTrackingService(processingServiceLike as any);
    return trackingServiceCache;
  } catch (error: any) {
    log.error('Failed to create tracking service', {
      error: error.message,
    });
    throw error;
  }
}

// Implementation of tracking activities
export const journeyTrackingActivities: JourneyTrackingActivities = {
  async trackJourneyStarted(
    context: JourneyTrackingContext,
    triggerEvent?: any,
  ): Promise<void> {
    // Don't skip tracking - we want to send to Kafka
    log.info('Tracking journey started', {
      sessionId: context.sessionId,
      journeyId: context.journeyId,
      contactId: context.contactId,
    });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackJourneyStarted(context, triggerEvent);
      log.info('Successfully tracked journey started', {
        sessionId: context.sessionId,
      });
    } catch (error: any) {
      log.error('Failed to track journey started', {
        sessionId: context.sessionId,
        error: error.message,
        stack: error.stack,
      });
      // Don't throw - tracking failures shouldn't stop journey execution
    }
  },

  async trackJourneyCompleted(
    context: JourneyTrackingContext,
    completionData: {
      completedNodes: string[];
      totalExecutionTime: number;
      finalStatus: string;
    },
  ): Promise<void> {

    // log.info('Tracking journey completed', {
    //   sessionId: context.sessionId,
    //   journeyId: context.journeyId,
    //   finalStatus: completionData.finalStatus,
    // });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackJourneyCompleted(context, completionData);
    } catch (error: any) {
      log.error('Failed to track journey completed', {
        sessionId: context.sessionId,
        error: error.message,
      });
    }
  },

  async trackJourneyFailed(
    context: JourneyTrackingContext,
    failureData: {
      error: string;
      failedNodeId?: string;
      completedNodes: string[];
    },
  ): Promise<void> {

    // log.info('Tracking journey failed', {
    //   sessionId: context.sessionId,
    //   journeyId: context.journeyId,
    //   error: failureData.error,
    // });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackJourneyFailed(context, failureData);
    } catch (error: any) {
      log.error('Failed to track journey failed', {
        sessionId: context.sessionId,
        error: error.message,
      });
    }
  },

  async trackNodeExecution(
    context: JourneyTrackingContext,
    tracking: NodeExecutionTracking,
  ): Promise<void> {
    // Don't skip tracking - we want to send to Kafka
    log.debug('Tracking node execution', {
      sessionId: context.sessionId,
      nodeId: tracking.nodeId,
      nodeType: tracking.nodeType,
      status: tracking.status,
    });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackNodeExecution(context, tracking);
      log.debug('Successfully tracked node execution', {
        sessionId: context.sessionId,
        nodeId: tracking.nodeId,
      });
    } catch (error: any) {
      log.error('Failed to track node execution', {
        sessionId: context.sessionId,
        nodeId: tracking.nodeId,
        error: error.message,
      });
    }
  },

  async trackNodeTransition(
    context: JourneyTrackingContext,
    transition: {
      fromNodeId: string;
      fromNodeType: string;
      toNodeId: string;
      toNodeType: string;
      handle?: string;
      transitionReason?: string;
    },
  ): Promise<void> {

    // log.debug('Tracking node transition', {
    //   sessionId: context.sessionId,
    //   fromNodeId: transition.fromNodeId,
    //   toNodeId: transition.toNodeId,
    // });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackNodeTransition(context, transition);
    } catch (error: any) {
      log.error('Failed to track node transition', {
        sessionId: context.sessionId,
        error: error.message,
      });
    }
  },

  async trackConditionalEvaluation(
    context: JourneyTrackingContext,
    evaluation: {
      nodeId: string;
      paths: Array<{
        pathId: string;
        pathName: string;
        conditions: any[];
        matched: boolean;
        evaluationTime: number;
      }>;
      selectedPath: string;
      selectedPathName: string;
    },
  ): Promise<void> {

    // log.debug('Tracking conditional evaluation', {
    //   sessionId: context.sessionId,
    //   nodeId: evaluation.nodeId,
    //   selectedPath: evaluation.selectedPath,
    // });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackConditionalEvaluation(context, evaluation);
    } catch (error: any) {
      log.error('Failed to track conditional evaluation', {
        sessionId: context.sessionId,
        nodeId: evaluation.nodeId,
        error: error.message,
      });
    }
  },

  async trackWaitEvent(
    context: JourneyTrackingContext,
    waitEvent: {
      nodeId: string;
      waitType: string;
      action: 'started' | 'completed' | 'timeout' | 'cancelled';
      waitDuration?: number;
      expectedDuration?: number;
      completionTrigger?: string;
    },
  ): Promise<void> {

    // log.debug('Tracking wait event', {
    //   sessionId: context.sessionId,
    //   nodeId: waitEvent.nodeId,
    //   action: waitEvent.action,
    // });

    try {
      const trackingService = await createTrackingService();
      await trackingService.trackWaitEvent(context, waitEvent);
    } catch (error: any) {
      log.error('Failed to track wait event', {
        sessionId: context.sessionId,
        nodeId: waitEvent.nodeId,
        error: error.message,
      });
    }
  },
};
