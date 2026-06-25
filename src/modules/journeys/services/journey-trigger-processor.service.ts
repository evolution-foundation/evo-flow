import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppFactory } from '../../../app-factory';
import { JourneysService } from '../journeys.service';
import { WaitRegistryService } from './wait-registry.service';
import {
  JourneySession,
  JourneySessionStatus,
} from '../entities/journey-session.entity';
import { getProcessingConfig } from '../../processing/config/processing.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { Client, Connection } from '@temporalio/client';
import { JourneySessionCacheService } from '../../cache/services/journey-session-cache.service';
import { JourneyExecutionPollerService } from '../../temporal/services/journey-execution-poller.service';
import { TEMPORAL_TASK_QUEUES } from '../../temporal/temporal-task-queues.constants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EventTrigger,
  WebhookTrigger,
  ContactCreatedTrigger,
  ContactUpdatedTrigger,
  SegmentTrigger,
  LabelTrigger,
  CustomAttributeTrigger,
  PipelineStageChangedTrigger,
  BaseTrigger,
} from './triggers';

export interface JourneyTriggerEvent {
  messageId: string;
  contactId: string;
  anonymousId?: string;
  eventName: string;
  eventType: string;
  properties: string;
  traits?: string;
  context?: string;
  timestamp: string;
}

@Injectable()
export class JourneyTriggerProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    JourneyTriggerProcessor.name,
  );
  private consumer: Consumer | null = null;
  private kafka: Kafka | null = null;
  private readonly config = getProcessingConfig();
  private readonly triggerHandlers: Map<string, BaseTrigger> = new Map();

  private temporalClient: Client | null = null;

  // Override injected cache service with singleton-enforced version
  private sessionCacheService: JourneySessionCacheService;

  constructor(
    private readonly journeysService: JourneysService,
    private readonly waitRegistry: WaitRegistryService,
    @InjectRepository(JourneySession)
    private readonly journeySessionRepository: Repository<JourneySession>,
    injectedSessionCacheService: JourneySessionCacheService,
    // EVO-1764: queue-health source of truth for the dispatch fail-fast guard.
    private readonly queueHealthPoller: JourneyExecutionPollerService,
  ) {
    this.initializeTriggerHandlers();
    // Initialize singleton cache service (async but don't wait)
    this.initializeSingletonCacheService(injectedSessionCacheService).catch(
      (error) => {
        this.logger.error(
          'Failed to initialize singleton cache service:',
          error.message,
        );
      },
    );
  }

  private async initializeSingletonCacheService(
    injectedService: JourneySessionCacheService,
  ) {
    // Create a new cache service instance that will detect trigger processor context
    // and use the Redis singleton
    const eventEmitter = new EventEmitter2();
    this.sessionCacheService = new JourneySessionCacheService(
      this.journeySessionRepository,
      eventEmitter,
    );

    // Force the base class to recognize we're in a trigger processor context
    // This ensures it will use the Redis singleton instead of creating new connections
    (this.sessionCacheService as any)._isForcedSingletonContext = true;

    this.logger.warn(
      '🔧 JourneyTriggerProcessor: Created cache service instance that will use Redis singleton',
    );

    // Verify the flag was set correctly
    if ((this.sessionCacheService as any)._isForcedSingletonContext) {
      this.logger.warn(
        '✅ JourneyTriggerProcessor: _isForcedSingletonContext flag is SET',
      );
    } else {
      this.logger.error(
        '❌ JourneyTriggerProcessor: _isForcedSingletonContext flag is NOT SET',
      );
    }
  }

  private initializeTriggerHandlers() {
    this.triggerHandlers.set('event', new EventTrigger());
    this.triggerHandlers.set('webhook', new WebhookTrigger());
    this.triggerHandlers.set('contactcreated', new ContactCreatedTrigger());
    this.triggerHandlers.set('contactupdated', new ContactUpdatedTrigger());
    this.triggerHandlers.set('segment', new SegmentTrigger());
    this.triggerHandlers.set('label', new LabelTrigger());
    this.triggerHandlers.set('customattribute', new CustomAttributeTrigger());
    this.triggerHandlers.set(
      'pipelinestagechanged',
      new PipelineStageChangedTrigger(),
    );
  }

  async onModuleInit() {
    // EVO-1764: gate the journey-triggers consumer on the JOURNEY worker modes
    // (SINGLE, TEMPORAL_WORKER) — NOT shouldStartTemporalWorker() which also
    // includes CAMPAIGN_WORKER. The fail-fast guard's queue-health poller only
    // runs in the journey-worker modes (shouldStartJourneyWorker), so a
    // CAMPAIGN_WORKER consuming the shared `temporal-workers` group would get
    // its share of journey-triggers partitions and dispatch them with the guard
    // permanently no-op (monitoring=false → isQueueUnexecutable short-circuits
    // to executable) — a silent split-brain stall. The campaign worker has no
    // reason to consume journey-triggers at all.
    if (AppFactory.shouldStartJourneyWorker()) {
      this.logger.log('🚀 Starting Journey Trigger Processor...');
      // EVO-1927: warm the active-journey cache from Postgres BEFORE consuming.
      // After a restart the Redis active-journey index is empty/stale and there
      // is no implicit warm-up, so the first events would otherwise match
      // against ZERO journeys and event-based triggers would silently die.
      // Best-effort: a warm-up failure falls back to the read-through in
      // JourneysService.findActive, so it must not block the consumer.
      try {
        const warmed = await this.journeysService.warmActiveJourneysCache();
        this.logger.log(
          `🔥 Warmed active-journey cache with ${warmed} journeys before consuming (EVO-1927)`,
        );
      } catch (error) {
        this.logger.warn(
          `⚠️ Failed to warm active-journey cache at boot (read-through fallback will cover this): ${error.message}`,
        );
      }
      await this.initializeKafkaConsumer();
      await this.startConsuming();
    } else {
      this.logger.log(
        '⏭️  Journey Trigger Processor disabled (not in a journey-worker mode)',
      );
    }
  }

  async onModuleDestroy() {
    if (this.consumer) {
      this.logger.log('🔄 Stopping Journey Trigger Processor...');
      await this.consumer.disconnect();
      this.logger.log('✅ Journey Trigger Processor stopped');
    }
  }

  private async initializeKafkaConsumer() {
    try {
      const kafkaBrokers = this.config.kafka?.brokers || ['kafka:29092'];
      const kafkaGroupId = 'temporal-workers';

      this.kafka = new Kafka({
        clientId: 'journey-trigger-processor',
        brokers: kafkaBrokers,
        retry: {
          retries: 10,
          initialRetryTime: 1000,
          maxRetryTime: 30000,
        },
      });

      // Kafka broker requires:
      // - sessionTimeout >= 6000ms (group.min.session.timeout.ms)
      // - sessionTimeout <= 300000ms (group.max.session.timeout.ms)
      // - heartbeatInterval <= sessionTimeout / 3
      this.consumer = this.kafka.consumer({
        groupId: kafkaGroupId,
        // Configurações para processamento eficiente
        sessionTimeout: 30000, // 30s - within broker limits
        heartbeatInterval: 3000, // 3s - must be <= sessionTimeout / 3
        maxBytesPerPartition: 1048576,
        minBytes: 1,
        maxBytes: 5242880,
        maxWaitTimeInMs: 5000,
      });

      this.logger.log(
        `✅ Kafka consumer initialized with brokers: ${kafkaBrokers.join(', ')}`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to initialize Kafka consumer: ${error.message}`,
      );
      throw error;
    }
  }

  private async startConsuming() {
    if (!this.consumer) {
      throw new Error('Consumer not initialized');
    }

    try {
      await this.consumer.connect();
      this.logger.log('🔗 Connected to Kafka');

      await this.consumer.subscribe({
        topic: 'journey-triggers',
        fromBeginning: false, // Processar apenas novos eventos
      });

      this.logger.log('📡 Subscribed to journey-triggers topic');

      await this.consumer.run({
        eachMessage: this.processMessage.bind(this),
        // Processamento em paralelo para performance
        partitionsConsumedConcurrently: 3,
      });

      this.logger.log(
        '🔄 Journey Trigger Processor is now consuming events...',
      );
    } catch (error) {
      this.logger.error(`❌ Failed to start consuming: ${error.message}`);
      throw error;
    }
  }

  private async processMessage({
    topic,
    partition,
    message,
  }: EachMessagePayload) {
    try {
      if (!message.value) {
        this.logger.warn('⚠️ Received empty message, skipping...');
        return;
      }

      const triggerEvent: JourneyTriggerEvent = JSON.parse(
        message.value.toString(),
      );

      this.logger.log(
        `📨 Processing trigger event: ${triggerEvent.eventName} for contact ${triggerEvent.contactId} `,
      );

      this.logger.log(`🔧 FULL TRIGGER EVENT DEBUG:`, {
        triggerEvent,
      });

      // TODO: Implement journey matching logic
      // For now, just log the structure without actual processing
      await this.analyzeEventForJourneyTriggers(triggerEvent);
    } catch (error) {
      this.logger.error(
        `❌ Error processing message from ${topic}/${partition}: ${error.message}`,
        error.stack,
      );

      // Em produção, aqui poderia enviar para uma dead letter queue
      // Por enquanto, apenas log do erro
    }
  }

  private async analyzeEventForJourneyTriggers(event: JourneyTriggerEvent) {
    try {
      this.logger.log(
        `🔍 Analyzing event for journey triggers: ${event.eventName}`,
      );

      // 1. First, check if event satisfies any waiting sessions
      await this.checkWaitingSessions(event);

      // 2. The active/waiting-session guard is applied per-journey at trigger
      // time (triggerJourneyExecution → checkForActiveOrWaitingSessions with the
      // journey id), so a dangling/active session in one journey no longer blocks
      // OTHER journeys for the same contact. A contact can run different journeys
      // concurrently; it still can't re-enter the same journey while active. EVO-1691.

      // 3. Buscar journeys ativas para o account
      const activeJourneys = await this.journeysService.findActive();

      this.logger.log(
        `🎯 Found ${activeJourneys.length} active journeys `,
      );

      // 4. Para cada journey, verificar se o evento satisfaz o trigger
      let matchedJourneys = 0;
      for (const journey of activeJourneys) {
        if (await this.matchesJourneyTrigger(event, journey)) {
          await this.triggerJourneyExecution(event, journey);
          matchedJourneys++;
        }
      }

      this.logger.log(
        `✅ Event analysis completed for ${event.eventName} - ${matchedJourneys} journeys matched`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Error analyzing event for journey triggers: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async matchesJourneyTrigger(
    event: JourneyTriggerEvent,
    journey: any,
  ): Promise<boolean> {
    this.logger.log(
      `🎯 Checking if event ${event.eventName} matches journey ${journey.id} (${journey.name})`,
    );

    if (!journey.flowTriggers || !Array.isArray(journey.flowTriggers)) {
      this.logger.log(`⚠️ Journey ${journey.id} has no valid flow triggers`);
      return false;
    }

    // Verificar cada trigger do journey
    for (const trigger of journey.flowTriggers) {
      if (await this.eventMatchesTrigger(event, trigger, journey)) {
        this.logger.log(
          `✅ Event matches trigger of type ${trigger.type} in journey ${journey.id}`,
        );
        return true;
      }
    }

    this.logger.log(
      `❌ Event does not match any triggers in journey ${journey.id}`,
    );
    return false;
  }

  private async eventMatchesTrigger(
    event: JourneyTriggerEvent,
    trigger: any,
    journey: any,
  ): Promise<boolean> {
    // Log completo do evento e trigger para debug
    this.logger.log(`🔧 FULL EVENT DEBUG:`, {
      event: event,
      trigger: trigger,
      journeyId: journey.id,
      journeyName: journey.name,
    });

    // Verificar tipo de trigger (case insensitive)
    const triggerType = trigger.type?.toLowerCase();
    const triggerHandler = this.triggerHandlers.get(triggerType);

    if (!triggerHandler) {
      this.logger.log(`⚠️ Unsupported trigger type: ${trigger.type}`);
      return false;
    }

    const result = await triggerHandler.matches(event, trigger, journey);
    return result.matches;
  }

  /**
   * Check if contact has any active or waiting sessions that should block new journey creation
   */
  private async checkForActiveOrWaitingSessions(
    contactId: string,
    journeyId?: string,
  ): Promise<boolean> {
    try {
      const contactSessions =
        await this.sessionCacheService.getSessionsByContact(contactId);

      // When journeyId is provided the guard is scoped to that journey only, so
      // a session in a different journey does not block this one (EVO-1691).
      const hasActiveOrWaiting = contactSessions.some(
        (session) =>
          (journeyId === undefined || session.journeyId === journeyId) &&
          (session.status === JourneySessionStatus.ACTIVE ||
            session.status === JourneySessionStatus.WAITING),
      );

      this.logger.log('Checking for active or waiting sessions', {
        contactId,
        totalSessions: contactSessions.length,
        activeOrWaitingSessions: contactSessions
          .filter(
            (s) =>
              (journeyId === undefined || s.journeyId === journeyId) &&
              (s.status === JourneySessionStatus.ACTIVE ||
                s.status === JourneySessionStatus.WAITING),
          )
          .map((s) => ({
            id: s.id,
            status: s.status,
            journeyId: s.journeyId,
            currentNodeId: s.currentNodeId,
            waitingFor: s.waitingFor ? 'YES' : 'NO',
          })),
        hasActiveOrWaiting,
      });

      return hasActiveOrWaiting;
    } catch (error) {
      this.logger.error('Error checking for active or waiting sessions', {
        contactId,
        error: error.message,
      });
      // On error, be conservative and allow the journey (don't block)
      return false;
    }
  }

  /**
   * Check if event satisfies any waiting sessions
   */
  private async checkWaitingSessions(
    event: JourneyTriggerEvent,
  ): Promise<void> {
    try {
      // 🔍 Use the same method that works to get all sessions, then filter WAITING ones
      const allSessions = await this.sessionCacheService.getSessionsByContact(
        event.contactId,
      );
      
      // Filter only WAITING sessions
      const waitingSessions = allSessions.filter(
        (session) => session.status === 'waiting' && session.waitingFor,
      );

      if (waitingSessions.length === 0) {
        this.logger.log('No waiting sessions found for contact', {
          contactId: event.contactId,
          eventName: event.eventName,
        });
        return;
      }

      this.logger.log(
        `Found ${waitingSessions.length} waiting sessions for contact`,
        {
          contactId: event.contactId,
          eventName: event.eventName,
          sessions: waitingSessions.map((s) => ({
            sessionId: s.id,
            nodeId: s.waitingFor?.nodeId,
          })),
        },
      );

      // Check each waiting session
      for (const session of waitingSessions) {
        const waitingFor = session.waitingFor;
        if (!waitingFor) continue;

        const { waitType, conditions } = waitingFor;

        // Only check event-based waits
        if (waitType !== 'event' && waitType !== 'time_or_condition') {
          continue;
        }

        // Check if event satisfies the wait condition
        const eventSatisfiesWait = await this.checkEventSatisfiesWait(
          event,
          conditions,
        );

        if (eventSatisfiesWait) {
          this.logger.log('Event satisfies wait condition, resuming journey', {
            sessionId: session.id,
            nodeId: waitingFor.nodeId,
            eventName: event.eventName,
            waitType,
            cachedSessionData: {
              id: session.id,
              workflowId: session.workflowId,
              status: session.status,
              journeyId: session.journeyId,
            },
          });

          // Send signal to resume workflow using workflowId from cache
          await this.resumeWaitingWorkflow(
            session.id,
            waitingFor.nodeId,
            'success',
            event,
            session.workflowId, // Pass workflowId from cache
          );
        }
      }
    } catch (error) {
      this.logger.error('Error checking waiting sessions', {
        contactId: event.contactId,
        eventName: event.eventName,
        error: error.message,
      });
      // Don't throw - this shouldn't block new journey creation
    }
  }

  /**
   * Check if event satisfies wait condition
   */
  private async checkEventSatisfiesWait(
    event: JourneyTriggerEvent,
    waitConditions: any,
  ): Promise<boolean> {
    try {
      // Use the same trigger matching logic but for wait conditions
      const eventType = waitConditions.eventType || 'event';
      const triggerHandler = this.triggerHandlers.get(eventType.toLowerCase());

      if (!triggerHandler) {
        this.logger.log('No trigger handler for wait event type', {
          eventType,
        });
        return false;
      }

      const result = await triggerHandler.matches(event, waitConditions, {});
      return result.matches;
    } catch (error) {
      this.logger.error('Error checking event wait satisfaction', {
        event: event.eventName,
        waitConditions,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Resume waiting workflow by sending Temporal signal
   */
  private async resumeWaitingWorkflow(
    sessionId: string,
    nodeId: string,
    result: 'success' | 'timeout',
    event?: JourneyTriggerEvent,
    cachedWorkflowId?: string,
  ): Promise<void> {
    try {
      const client = await this.getTemporalClient();

      // Get the workflow ID - use cached workflowId if provided, otherwise fallback to database lookup
      let workflowId = cachedWorkflowId;
      
      if (workflowId) {
        this.logger.log('🔍 DEBUG: Using workflowId from cache', {
          sessionId,
          workflowId,
        });
      } else {
        this.logger.log('🔍 DEBUG: No cached workflowId, looking up in database', {
          sessionId,
        });
        
        const { AppDataSource } = await import('../../../database/ormconfig');
        const { JourneySession } = await import(
          '../entities/journey-session.entity'
        );

        if (!AppDataSource.isInitialized) {
          await AppDataSource.initialize();
        }

        const sessionRepository = AppDataSource.getRepository(JourneySession);
        const session = await sessionRepository.findOne({
          where: { id: sessionId },
        });
        
        this.logger.log('🔍 DEBUG: Database session lookup result', {
          sessionId,
          foundSession: !!session,
          sessionData: session ? {
            id: session.id,
            workflowId: session.workflowId,
            status: session.status,
          } : null,
        });

        if (!session || !session.workflowId) {
          this.logger.error('Session not found or missing workflowId', {
            sessionId,
            hasSession: !!session,
            workflowId: session?.workflowId,
          });
          throw new Error('Session not found or missing workflowId');
        }
        
        workflowId = session.workflowId;
      }

      // Send wait completion signal using the correct workflow ID
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal('waitCompleted', {
        nodeId,
        result,
        completedAt: new Date().toISOString(),
        metadata: event
          ? {
              triggerEvent: {
                messageId: event.messageId,
                eventName: event.eventName,
                eventType: event.eventType,
                properties: JSON.parse(event.properties || '{}'),
                // identify-DTO payload (e.g. custom attribute) rides in traits — forward it
                // so VariableMapping can resolve it (EVO-1839).
                traits: JSON.parse(event.traits || '{}'),
                timestamp: event.timestamp,
              },
            }
          : undefined,
      });

      // Mark wait as completed using activities
      const { waitActivities } = await import(
        '../../temporal/activities/wait.activities'
      );
      await waitActivities.completeWait({ sessionId, nodeId, result });

      this.logger.log('Workflow resumed successfully', {
        sessionId,
        nodeId,
        result,
      });
    } catch (error) {
      this.logger.error('Failed to resume waiting workflow', {
        sessionId,
        nodeId,
        result,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get or create Temporal client
   */
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

  private async triggerJourneyExecution(
    event: JourneyTriggerEvent,
    journey: any,
  ): Promise<void> {
    this.logger.log(
      `🚀 Triggering journey execution: ${journey.id} (${journey.name}) for contact ${event.contactId}`,
    );

    try {
      // Block only if the contact already has an active/waiting session for THIS
      // journey — different journeys can run concurrently (EVO-1691).
      const hasExistingSession = await this.checkForActiveOrWaitingSessions(
        event.contactId,
        journey.id,
      );
      
      if (hasExistingSession) {
        this.logger.warn('⚠️ Blocking journey execution - contact has active or waiting session', {
          contactId: event.contactId,
          journeyId: journey.id,
          journeyName: journey.name,
          eventName: event.eventName,
        });
        return;
      }
      
      this.logger.log('✅ Session validation passed - proceeding with journey execution', {
        contactId: event.contactId,
        journeyId: journey.id,
        journeyName: journey.name,
      });

      // EVO-1896: idempotency guard. Kafka is at-least-once, so the SAME
      // trigger event can be redelivered after the first run already completed.
      // The active/waiting-session guard above only blocks concurrent re-entry;
      // it does not cover sequential replays of a terminal session. Dedup on the
      // producer-stable messageId — scoped to (journey, contact) — so a replay
      // of the exact same event is dropped while distinct events still start.
      // Atomic SET NX claims the messageId for the first caller (race-safe).
      // When messageId is absent we can't identify the event, so we skip the
      // dedup rather than block (degrades to today's behaviour, no false drops).
      if (event.messageId) {
        const claimed = await this.sessionCacheService.tryClaimTriggerMessage(
          journey.id,
          event.contactId,
          event.messageId,
        );

        if (!claimed) {
          this.logger.warn(
            '⏭️  Skipping duplicate trigger — messageId already processed for this journey/contact (EVO-1896)',
            {
              contactId: event.contactId,
              journeyId: journey.id,
              journeyName: journey.name,
              messageId: event.messageId,
              eventName: event.eventName,
            },
          );
          return;
        }
      } else {
        this.logger.warn(
          '⚠️ Trigger event has no messageId — idempotency dedup skipped (EVO-1896)',
          {
            contactId: event.contactId,
            journeyId: journey.id,
            eventName: event.eventName,
          },
        );
      }

      // Import JourneyExecutionWorkflow
      const { JourneyExecutionWorkflow } = await import(
        '../../temporal/workflows/journey-execution.workflow'
      );

      const client = await this.getTemporalClient();

      // Generate unique workflow ID
      const workflowId = `journey-${journey.id}-contact-${event.contactId}-${Date.now()}`;

      // Generate a unique session ID as UUID
      const { randomUUID } = await import('crypto');
      const sessionId = randomUUID();


      // Prepare workflow arguments matching JourneyExecutionInput interface
      const workflowArgs = {
        sessionId,
        journeyId: journey.id,
        contactId: event.contactId,
        triggerEvent: {
          messageId: event.messageId,
          eventName: event.eventName,
          eventType: event.eventType,
          properties: JSON.parse(event.properties || '{}'),
          // identify-DTO payload (e.g. custom attribute) rides in traits — forward it
          // so VariableMapping can resolve it (EVO-1839).
          traits: JSON.parse(event.traits || '{}'),
          timestamp: event.timestamp,
        },
      };

      // Start the workflow
      const handle = await client.workflow.start(JourneyExecutionWorkflow, {
        taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
        workflowId,
        args: [workflowArgs],
        workflowExecutionTimeout: '30d', // Journey pode durar até 30 dias com waits
        workflowTaskTimeout: '1m',
      });

      // EVO-1764 fail-fast guard: a workflow needs a WORKFLOW poller to run even
      // its first line, so if journey-execution has genuinely no executor the
      // workflow we just enqueued sits unstarted until the 30d execution
      // timeout. Detect that and surface it instead of reporting success. The
      // check is a *fresh* live poll (closes the start→verdict race) and gates
      // on *sustained* zero, so a transient Temporal restart/reconnect — from
      // which the worker auto-recovers (EVO-1758) — never trips it.
      const { unexecutable, status } =
        await this.queueHealthPoller.isQueueUnexecutable();
      if (unexecutable) {
        // Terminate the just-started workflow so the session (failed) and the
        // workflow (terminated) stay consistent — otherwise a worker appearing
        // later would run a journey whose session is already failed.
        await handle
          .terminate(
            'no journey-execution worker available at dispatch (EVO-1764)',
          )
          .catch((e) =>
            this.logger.warn(
              `Failed to terminate undispatched workflow ${workflowId}: ${e.message}`,
            ),
          );

        await this.sessionCacheService.createFailedDispatchSession({
          sessionId,
          journeyId: journey.id,
          contactId: event.contactId,
          workflowId,
          workflowRunId: handle.firstExecutionRunId,
          errorMessage:
            'no journey-execution worker available — journey not dispatched',
        });

        this.logger.warn(
          '⛔ Journey not dispatched: no journey-execution worker',
          {
            journeyId: journey.id,
            journeyName: journey.name,
            contactId: event.contactId,
            sessionId,
            workflowId,
            sustainedZeroMs: status.sustainedZeroMs,
          },
        );

        // Deliberately do NOT throw: the trigger is committed, not retried.
        // Re-queueing while the queue has no worker only builds backlog; the
        // readiness 503 + zero-poller gauge alert ops to restore the worker, and
        // new triggers flow once it returns. The failed session row keeps this
        // drop auditable (EVO-1764 fail-fast decision).
        return;
      }

      // Update session with workflow information
      await this.sessionCacheService.updateSessionStatus(sessionId, 'active', {
        workflowId,
        workflowRunId: handle.firstExecutionRunId,
      });

      this.logger.log(
        `✅ Journey workflow started successfully: ${workflowId}`,
        {
          journeyId: journey.id,
          journeyName: journey.name,
          contactId: event.contactId,
          sessionId,
          workflowId,
          runId: handle.firstExecutionRunId,
        },
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to start journey workflow for journey ${journey.id}`,
        {
          error: error.message,
          stack: error.stack,
          journeyId: journey.id,
          contactId: event.contactId,
        },
      );

      // Em produção, enviar para dead letter queue para retry
      throw error;
    }
  }

  // Health check method for monitoring
  async getProcessorStatus() {
    return {
      status: this.consumer ? 'connected' : 'disconnected',
      // Mirrors the onModuleInit gate (journey-worker modes only) — EVO-1764.
      isRunning: AppFactory.shouldStartJourneyWorker(),
      config: {
        topic: 'journey-triggers',
        groupId: 'temporal-workers',
        brokers: this.config.kafka?.brokers || ['kafka:29092'],
      },
    };
  }
}
