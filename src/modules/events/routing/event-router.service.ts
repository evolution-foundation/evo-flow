import { Injectable } from '@nestjs/common';
import {
  ProcessingEvent,
  EventClassification,
  EventPriority,
  ProcessingLayer,
  RoutingDecision,
  EventRouterContext,
  ISegmentEventRouter,
  SegmentComplexityMetrics,
} from '../types/routing.types';
import { SegmentNode } from '../../segments/types/segment-computation.types';
import { EventAnalyzerService } from './event-analyzer.service';
import { EventRoutingConfigHelper } from '../constants/routing-config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * Event Router for hybrid segment processing
 * Routes events to ATOMIC/BATCH/CRON layers based on CRM event characteristics
 */
@Injectable()
export class EventRouterService implements ISegmentEventRouter {
  private readonly logger = new CustomLoggerService(EventRouterService.name);

  constructor(private readonly eventAnalyzer: EventAnalyzerService) {}

  /**
   * Main routing logic - routes CRM events to appropriate processing layer
   */
  async routeEvent(context: EventRouterContext): Promise<RoutingDecision> {
    const startTime = Date.now();

    try {
      // Step 1: Classify the CRM event type
      const classification = this.classifyEvent(context.event);

      // Step 2: Determine event priority based on CRM business impact
      const priority = await this.eventAnalyzer.determineEventPriority(
        context.event,
        context.affectedSegments.length,
      );

      // Step 3: Calculate complexity for affected segments
      const maxComplexity = this.calculateMaxSegmentComplexity(
        context.affectedSegments.map((s) => s.definition),
      );

      // Step 4: Make routing decision based on CRM context
      const decision = this.makeRoutingDecision({
        classification,
        priority,
        maxComplexity,
        systemLoad: context.systemLoad,
        affectedSegmentsCount: context.affectedSegments.length,
      });

      this.logger.debug(
        `CRM Event ${context.event.id} routed to ${decision.layer} layer`,
        {
          eventType: context.event.type,
          classification,
          priority,
          affectedSegments: context.affectedSegments.length,
          routingTime: Date.now() - startTime,
        },
      );

      return decision;
    } catch (error) {
      this.logger.error(
        `Error routing CRM event ${context.event.id}: ${error.message}`,
        error.stack,
      );

      // Fallback to BATCH layer on error
      return {
        layer: ProcessingLayer.BATCH,
        priority: EventPriority.NORMAL,
        classification: EventClassification.SYSTEM,
        reason: 'Error fallback - routed to BATCH layer',
        estimatedProcessingTime: 15000,
        requiresImmediateProcessing: false,
      };
    }
  }

  /**
   * Classify CRM/communication events using configuration
   */
  classifyEvent(event: ProcessingEvent): EventClassification {
    // Use configuration helper to get classification
    const classification = EventRoutingConfigHelper.getEventClassification(
      event.type,
    );

    // Return classification or default to SYSTEM
    return classification || EventClassification.SYSTEM;
  }

  /**
   * Calculate complexity metrics for a segment definition
   */
  calculateComplexity(
    segmentDefinition: SegmentNode,
  ): SegmentComplexityMetrics {
    return {
      nodeCount: this.countNodes(segmentDefinition),
      hasTimeConstraints: this.hasTimeConstraints(segmentDefinition),
      hasCustomAttributes: this.hasCustomAttributes(segmentDefinition),
      hasPerformedEvents: this.hasPerformedEvents(segmentDefinition),
      estimatedContactCount: this.estimateContactCount(segmentDefinition),
    };
  }

  /**
   * Make final routing decision based on CRM context
   */
  private makeRoutingDecision({
    classification,
    priority,
    maxComplexity,
    systemLoad,
    affectedSegmentsCount,
  }: {
    classification: EventClassification;
    priority: EventPriority;
    maxComplexity: SegmentComplexityMetrics;
    systemLoad: {
      currentCpu: number;
      currentMemory: number;
      kafkaLag: number;
      activeJobs: number;
    };
    affectedSegmentsCount: number;
  }): RoutingDecision {
    // ATOMIC layer criteria (< 1s processing)
    if (
      this.shouldUseAtomicLayer(
        priority,
        maxComplexity,
        affectedSegmentsCount,
        systemLoad,
      )
    ) {
      return {
        layer: ProcessingLayer.ATOMIC,
        priority,
        classification,
        reason:
          'Critical CRM event with low complexity - immediate processing required',
        estimatedProcessingTime: 500,
        requiresImmediateProcessing: true,
      };
    }

    // BATCH layer criteria (5-30s processing)
    if (
      this.shouldUseBatchLayer(priority, maxComplexity, affectedSegmentsCount)
    ) {
      return {
        layer: ProcessingLayer.BATCH,
        priority,
        classification,
        reason: 'Medium complexity CRM event - batch processing appropriate',
        estimatedProcessingTime: 15000,
        suggestedBatchSize: this.calculateOptimalBatchSize(maxComplexity),
        requiresImmediateProcessing: false,
      };
    }

    // Default to CRON layer (5-60min processing)
    return {
      layer: ProcessingLayer.CRON,
      priority,
      classification,
      reason:
        'High complexity or low priority CRM event - scheduled processing',
      estimatedProcessingTime: 300000, // 5 minutes
      requiresImmediateProcessing: false,
    };
  }

  /**
   * Determine if CRM event should use ATOMIC layer
   */
  private shouldUseAtomicLayer(
    priority: EventPriority,
    complexity: SegmentComplexityMetrics,
    segmentCount: number,
    systemLoad: any,
  ): boolean {
    // High system load - avoid atomic processing
    if (systemLoad.currentCpu > 80 || systemLoad.kafkaLag > 1000) {
      return false;
    }

    // Critical priority CRM events with low complexity
    if (priority === EventPriority.CRITICAL) {
      return (
        complexity.nodeCount <= 5 &&
        complexity.estimatedContactCount <= 1000 &&
        segmentCount <= 3 &&
        !complexity.hasTimeConstraints
      );
    }

    return false;
  }

  /**
   * Determine if CRM event should use BATCH layer
   */
  private shouldUseBatchLayer(
    priority: EventPriority,
    complexity: SegmentComplexityMetrics,
    segmentCount: number,
  ): boolean {
    // High priority CRM events
    if (priority >= EventPriority.HIGH) {
      return (
        complexity.nodeCount <= 15 &&
        complexity.estimatedContactCount <= 50000 &&
        segmentCount <= 10
      );
    }

    // Normal priority with reasonable complexity
    if (priority === EventPriority.NORMAL) {
      return (
        complexity.nodeCount <= 10 &&
        complexity.estimatedContactCount <= 10000 &&
        segmentCount <= 5
      );
    }

    return false;
  }

  /**
   * Calculate optimal batch size based on segment complexity
   */
  private calculateOptimalBatchSize(
    complexity: SegmentComplexityMetrics,
  ): number {
    let batchSize = 100; // Default batch size

    // Reduce batch size for complex segments
    if (complexity.hasTimeConstraints) batchSize *= 0.7;
    if (complexity.hasCustomAttributes) batchSize *= 0.8;
    if (complexity.hasPerformedEvents) batchSize *= 0.9;
    if (complexity.estimatedContactCount > 10000) batchSize *= 0.6;

    return Math.max(Math.floor(batchSize), 10); // Minimum batch size of 10
  }

  /**
   * Calculate maximum complexity from multiple segments
   */
  private calculateMaxSegmentComplexity(
    definitions: SegmentNode[],
  ): SegmentComplexityMetrics {
    if (definitions.length === 0) {
      return {
        nodeCount: 0,
        hasTimeConstraints: false,
        hasCustomAttributes: false,
        hasPerformedEvents: false,
        estimatedContactCount: 0,
      };
    }

    const complexities = definitions.map((def) =>
      this.calculateComplexity(def),
    );

    return {
      nodeCount: Math.max(...complexities.map((c) => c.nodeCount)),
      hasTimeConstraints: complexities.some((c) => c.hasTimeConstraints),
      hasCustomAttributes: complexities.some((c) => c.hasCustomAttributes),
      hasPerformedEvents: complexities.some((c) => c.hasPerformedEvents),
      estimatedContactCount: Math.max(
        ...complexities.map((c) => c.estimatedContactCount),
      ),
    };
  }

  // Helper methods for segment complexity analysis
  private countNodes(node: SegmentNode): number {
    let count = 1;
    if (node.children && node.children.length > 0) {
      count += node.children.reduce(
        (sum, child) => sum + this.countNodes(child),
        0,
      );
    }
    return count;
  }

  private hasTimeConstraints(node: SegmentNode): boolean {
    if (node.type === 'lastPerformed' || node.type === 'performed') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasTimeConstraints(child));
    }
    return false;
  }

  private hasCustomAttributes(node: SegmentNode): boolean {
    if (node.type === 'customAttribute') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasCustomAttributes(child));
    }
    return false;
  }

  private hasPerformedEvents(node: SegmentNode): boolean {
    if (node.type === 'performed' || node.type === 'lastPerformed') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasPerformedEvents(child));
    }
    return false;
  }

  private estimateContactCount(node: SegmentNode): number {
    // CRM-specific contact count estimation
    switch (node.type) {
      case 'everyone':
        return 100000; // All contacts
      case 'has_label':
      case 'not_has_label':
        return 5000; // Typical label usage in CRM
      case 'customAttribute':
        return 2000; // Custom attributes are selective
      case 'performed':
      case 'lastPerformed':
        return 1000; // Specific CRM behavior events
      default:
        return 1000; // Conservative estimate
    }
  }
}
