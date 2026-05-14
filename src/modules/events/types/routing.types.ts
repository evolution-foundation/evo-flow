import { SegmentNode } from '../../segments/types/segment-computation.types';

/**
 * Event routing and processing types for the hybrid segment architecture
 * Based on SEGMENT_ROUTING_STRATEGY_FINAL.md
 */

export enum ProcessingLayer {
  ATOMIC = 'atomic', // < 1s processing
  BATCH = 'batch', // 5-30s processing
  CRON = 'cron', // 5-60min processing
}

export enum EventPriority {
  CRITICAL = 'critical', // Real-time events requiring immediate processing
  HIGH = 'high', // Important events processed in batches
  NORMAL = 'normal', // Standard events for cron processing
  LOW = 'low', // Bulk events processed during off-peak
}

export enum EventClassification {
  COMMUNICATION = 'communication', // email, whatsapp, sms events
  BEHAVIORAL = 'behavioral', // track, page, identify events
  LIFECYCLE = 'lifecycle', // contact_created, updated events
  SYSTEM = 'system', // Internal system events
}

export interface ProcessingEvent {
  id: string;
  type: string;
  contactId?: string;
  anonymousId?: string;
  timestamp: number;
  data: Record<string, any>;

  // Routing metadata
  priority?: EventPriority;
  classification?: EventClassification;
  estimatedSegments?: number;
}

export interface SegmentComplexityMetrics {
  nodeCount: number;
  hasTimeConstraints: boolean;
  hasCustomAttributes: boolean;
  hasPerformedEvents: boolean;
  estimatedContactCount: number;
  lastComputationTimeMs?: number;
}

export interface RoutingDecision {
  layer: ProcessingLayer;
  priority: EventPriority;
  classification: EventClassification;
  reason: string;
  estimatedProcessingTime: number;
  suggestedBatchSize?: number;
  requiresImmediateProcessing: boolean;
}

export interface EventRouterContext {
  event: ProcessingEvent;
  affectedSegments: {
    id: string;
    name: string;
    definition: SegmentNode;
    complexity: SegmentComplexityMetrics;
  }[];
  systemLoad: {
    currentCpu: number;
    currentMemory: number;
    kafkaLag: number;
    activeJobs: number;
  };
}

/**
 * Interface for the main event router
 */
export interface ISegmentEventRouter {
  /**
   * Route an event to the appropriate processing layer
   */
  routeEvent(context: EventRouterContext): Promise<RoutingDecision>;

  /**
   * Classify event type based on routing rules
   */
  classifyEvent(event: ProcessingEvent): EventClassification;

  /**
   * Calculate segment complexity metrics
   */
  calculateComplexity(segmentDefinition: SegmentNode): SegmentComplexityMetrics;
}

/**
 * Interface for event analysis and priority determination
 */
export interface IEventAnalyzer {
  /**
   * Determine event priority based on business impact
   */
  determineEventPriority(
    event: ProcessingEvent,
    affectedSegmentsCount: number,
  ): Promise<EventPriority>;

  /**
   * Check if event is critical for business operations
   */
  isCriticalBusinessEvent(event: ProcessingEvent): boolean;

  /**
   * Calculate impact level (0-100) based on event characteristics
   */
  calculateImpactLevel(
    event: ProcessingEvent,
    affectedSegmentsCount: number,
  ): number;
}
