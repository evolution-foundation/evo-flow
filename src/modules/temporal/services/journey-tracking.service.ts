import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { ProcessingService } from '../../processing/processing.service';
import { EventData } from '../../processing/interfaces/event-data.interface';
import { EventType } from '../../../common/enums/event-type.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface JourneyTrackingContext {
  sessionId: string;
  journeyId: string;
  contactId: string;
  workflowId?: string;
  runId?: string;
}

export interface NodeExecutionTracking {
  nodeId: string;
  nodeType: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  executionTime?: number;
  startTime?: Date;
  endTime?: Date;
  error?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class JourneyTrackingService {
  private readonly logger = new CustomLoggerService(
    JourneyTrackingService.name,
  );

  constructor(
    @Inject(forwardRef(() => ProcessingService))
    private readonly processingService: ProcessingService,
  ) {}

  /**
   * Track journey started
   */
  async trackJourneyStarted(
    context: JourneyTrackingContext,
    triggerEvent?: any,
  ): Promise<void> {
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `journey-started-${context.sessionId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: 'journey_started',
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        trigger_event: triggerEvent?.eventName,
        trigger_type: triggerEvent?.eventType,
        started_at: eventTime,
        event_category: 'journey_execution',
      },
      timestamp: eventTime,
    };

    this.logger.log('About to call processingService.processEvent', {
      messageId: eventData.messageId,
      eventName: eventData.eventName,
    });
    
    const result = await this.processingService./* The `processEvent` method in the
    `JourneyTrackingService` class is responsible for
    processing an event by sending event data to the
    `ProcessingService`. This method is used to track
    various events related to a journey execution, such
    as journey started, journey completed, node
    execution, node transition, conditional path
    evaluation, and wait node events. */
    processEvent(eventData);
    
    this.logger.log('ProcessingService.processEvent result', {
      messageId: result.messageId,
      status: result.status,
      error: result.error,
    });

    this.logger.debug('Tracked journey started event', {
      sessionId: context.sessionId,
      journeyId: context.journeyId,
      contactId: context.contactId,
    });
  }

  /**
   * Track journey completed
   */
  async trackJourneyCompleted(
    context: JourneyTrackingContext,
    completionData: {
      completedNodes: string[];
      totalExecutionTime: number;
      finalStatus: string;
    },
  ): Promise<void> {
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `journey-completed-${context.sessionId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: 'journey_completed',
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        final_status: completionData.finalStatus,
        completed_nodes: completionData.completedNodes,
        total_nodes_executed: completionData.completedNodes.length,
        total_execution_time_ms: completionData.totalExecutionTime,
        completed_at: eventTime,
        event_category: 'journey_execution',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked journey completed event', {
      sessionId: context.sessionId,
      journeyId: context.journeyId,
      finalStatus: completionData.finalStatus,
    });
  }

  /**
   * Track journey failed
   */
  async trackJourneyFailed(
    context: JourneyTrackingContext,
    failureData: {
      error: string;
      failedNodeId?: string;
      completedNodes: string[];
    },
  ): Promise<void> {
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `journey-failed-${context.sessionId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: 'journey_failed',
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        error_message: failureData.error,
        failed_node_id: failureData.failedNodeId,
        completed_nodes: failureData.completedNodes,
        nodes_completed_before_failure: failureData.completedNodes.length,
        failed_at: eventTime,
        event_category: 'journey_execution',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked journey failed event', {
      sessionId: context.sessionId,
      journeyId: context.journeyId,
      error: failureData.error,
    });
  }

  /**
   * Track individual node execution
   */
  async trackNodeExecution(
    context: JourneyTrackingContext,
    tracking: NodeExecutionTracking,
  ): Promise<void> {
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `node-${tracking.status}-${context.sessionId}-${tracking.nodeId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: `node_${tracking.status}`,
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        node_id: tracking.nodeId,
        node_type: tracking.nodeType,
        execution_time_ms: tracking.executionTime,
        start_time: tracking.startTime instanceof Date ? tracking.startTime.toISOString() : tracking.startTime,
        end_time: tracking.endTime instanceof Date ? tracking.endTime.toISOString() : tracking.endTime,
        error_message: tracking.error,
        metadata: tracking.metadata,
        event_category: 'node_execution',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked node execution event', {
      sessionId: context.sessionId,
      nodeId: tracking.nodeId,
      nodeType: tracking.nodeType,
      status: tracking.status,
    });
  }

  /**
   * Track node transition (from one node to another)
   */
  async trackNodeTransition(
    context: JourneyTrackingContext,
    transition: {
      fromNodeId: string;
      fromNodeType: string;
      toNodeId: string;
      toNodeType: string;
      handle?: string; // For conditional paths
      transitionReason?: string;
    },
  ): Promise<void> {
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `node-transition-${context.sessionId}-${transition.fromNodeId}-${transition.toNodeId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: 'node_transition',
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        from_node_id: transition.fromNodeId,
        from_node_type: transition.fromNodeType,
        to_node_id: transition.toNodeId,
        to_node_type: transition.toNodeType,
        transition_handle: transition.handle,
        transition_reason: transition.transitionReason,
        transitioned_at: eventTime,
        event_category: 'journey_flow',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked node transition event', {
      sessionId: context.sessionId,
      fromNodeId: transition.fromNodeId,
      toNodeId: transition.toNodeId,
    });
  }

  /**
   * Track conditional path evaluation
   */
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
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `conditional-evaluated-${context.sessionId}-${evaluation.nodeId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: 'conditional_evaluation',
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        node_id: evaluation.nodeId,
        paths_evaluated: evaluation.paths.length,
        selected_path_id: evaluation.selectedPath,
        selected_path_name: evaluation.selectedPathName,
        path_evaluations: evaluation.paths,
        total_evaluation_time_ms: evaluation.paths.reduce(
          (sum, p) => sum + p.evaluationTime,
          0,
        ),
        evaluated_at: eventTime,
        event_category: 'conditional_logic',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked conditional evaluation event', {
      sessionId: context.sessionId,
      nodeId: evaluation.nodeId,
      selectedPath: evaluation.selectedPath,
    });
  }

  /**
   * Track wait node events
   */
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
    const eventTime = new Date().toISOString();

    const eventData: EventData = {
      messageId: `wait-${waitEvent.action}-${context.sessionId}-${waitEvent.nodeId}-${Date.now()}`,
      contactId: context.contactId,
      eventType: EventType.TRACK as any,
      eventName: `wait_${waitEvent.action}`,
      properties: {
        journey_id: context.journeyId,
        session_id: context.sessionId,
        workflow_id: context.workflowId,
        run_id: context.runId,
        node_id: waitEvent.nodeId,
        wait_type: waitEvent.waitType,
        actual_wait_duration_ms: waitEvent.waitDuration,
        expected_duration_ms: waitEvent.expectedDuration,
        completion_trigger: waitEvent.completionTrigger,
        event_category: 'wait_handling',
      },
      timestamp: eventTime,
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug('Tracked wait event', {
      sessionId: context.sessionId,
      nodeId: waitEvent.nodeId,
      action: waitEvent.action,
    });
  }
}