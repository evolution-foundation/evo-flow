import { Injectable } from '@nestjs/common';
import {
  ProcessingLayer,
  EventPriority,
  SegmentComplexityMetrics,
} from '../../events/types/routing.types';
import { SegmentNode } from '../../segments/types/segment-computation.types';
import { SegmentClassifierService } from './segment-classifier.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface ProcessingStrategyDecision {
  layer: ProcessingLayer;
  priority: EventPriority;
  debounceWindowMs: number;
  batchSize?: number;
  estimatedProcessingTime: number;
  reason: string;
}

export interface SegmentProcessingContext {
  segmentId: string;
  segmentDefinition: SegmentNode;
  actualContactCount?: number;
  systemLoad: {
    currentCpu: number;
    currentMemory: number;
    queueDepth: number;
  };
  eventPriority: EventPriority;
}

/**
 * Processing Strategy Service
 * Determines final processing strategies and debounce windows
 * Following SEGMENT_IMPLEMENTATION_TIMELINE.md requirements
 */
@Injectable()
export class ProcessingStrategyService {
  private readonly logger = new CustomLoggerService(
    ProcessingStrategyService.name,
  );

  constructor(private readonly segmentClassifier: SegmentClassifierService) {}

  /**
   * Determine final processing strategy for a segment
   * Combines classification with system context and event priority
   */
  determineStrategy(
    context: SegmentProcessingContext,
  ): ProcessingStrategyDecision {
    const complexity = this.segmentClassifier.analyzeComplexity(
      context.segmentDefinition,
    );

    const contactCount =
      context.actualContactCount || complexity.estimatedContactCount;

    // Get base classification from segment complexity
    const baseLayer = this.segmentClassifier.classifySegment(
      context.segmentDefinition,
      contactCount,
    );

    // Adjust based on event priority and system load
    const finalLayer = this.adjustLayerForContext(
      baseLayer,
      context.eventPriority,
      context.systemLoad,
      complexity,
    );

    // Calculate debounce window based on layer and complexity
    const debounceWindowMs = this.calculateDebounceWindow(
      finalLayer,
      complexity,
      context.eventPriority,
    );

    // Determine batch size for batch processing
    const batchSize =
      finalLayer === ProcessingLayer.BATCH
        ? this.calculateBatchSize(complexity, contactCount)
        : undefined;

    // Estimate processing time
    const estimatedProcessingTime = this.estimateProcessingTime(
      finalLayer,
      complexity,
      contactCount,
    );

    const decision: ProcessingStrategyDecision = {
      layer: finalLayer,
      priority: context.eventPriority,
      debounceWindowMs,
      batchSize,
      estimatedProcessingTime,
      reason: this.generateDecisionReason(
        baseLayer,
        finalLayer,
        context.eventPriority,
        complexity,
      ),
    };

    this.logger.debug('Processing strategy determined', {
      segmentId: context.segmentId,
      layer: finalLayer,
      debounceWindowMs,
      complexity: complexity.nodeCount,
      contactCount,
      priority: context.eventPriority,
    });

    return decision;
  }

  /**
   * Adjust processing layer based on event priority and system load
   */
  private adjustLayerForContext(
    baseLayer: ProcessingLayer,
    eventPriority: EventPriority,
    systemLoad: SegmentProcessingContext['systemLoad'],
    complexity: SegmentComplexityMetrics,
  ): ProcessingLayer {
    // High system load - prefer delayed processing
    if (systemLoad.currentCpu > 80 || systemLoad.queueDepth > 1000) {
      // Force high priority to batch if system is overloaded
      if (
        baseLayer === ProcessingLayer.ATOMIC &&
        eventPriority >= EventPriority.HIGH
      ) {
        return ProcessingLayer.BATCH;
      }
      // Move batch to cron if system is very overloaded
      if (baseLayer === ProcessingLayer.BATCH && systemLoad.currentCpu > 90) {
        return ProcessingLayer.CRON;
      }
    }

    // Critical priority can force immediate processing for simple segments
    if (eventPriority === EventPriority.CRITICAL) {
      if (
        complexity.nodeCount <= 5 &&
        complexity.estimatedContactCount <= 5000
      ) {
        return ProcessingLayer.ATOMIC;
      }
    }

    // Low priority - prefer delayed processing
    if (eventPriority === EventPriority.LOW) {
      if (baseLayer === ProcessingLayer.ATOMIC) {
        return ProcessingLayer.BATCH;
      }
      if (baseLayer === ProcessingLayer.BATCH) {
        return ProcessingLayer.CRON;
      }
    }

    return baseLayer;
  }

  /**
   * Calculate debounce window based on processing layer and complexity
   * Prevents unnecessary recomputation from rapid event sequences
   */
  calculateDebounceWindow(
    layer: ProcessingLayer,
    complexity: SegmentComplexityMetrics,
    eventPriority: EventPriority,
  ): number {
    let baseWindow: number;

    // Base debounce windows by processing layer
    switch (layer) {
      case ProcessingLayer.ATOMIC:
        baseWindow = 100; // 100ms - minimal debouncing for immediate processing
        break;
      case ProcessingLayer.BATCH:
        baseWindow = 5000; // 5s - reasonable batching window
        break;
      case ProcessingLayer.CRON:
        baseWindow = 300000; // 5min - longer debouncing for scheduled processing
        break;
      default:
        baseWindow = 5000;
    }

    // Adjust based on complexity
    let complexityMultiplier = 1;
    if (complexity.hasTimeConstraints) complexityMultiplier *= 1.5;
    if (complexity.hasCustomAttributes) complexityMultiplier *= 1.2;
    if (complexity.hasPerformedEvents) complexityMultiplier *= 1.3;
    if (complexity.nodeCount > 5) complexityMultiplier *= 1.1;

    // Adjust based on event priority
    let priorityMultiplier = 1;
    switch (eventPriority) {
      case EventPriority.CRITICAL:
        priorityMultiplier = 0.5; // Shorter debounce for critical events
        break;
      case EventPriority.HIGH:
        priorityMultiplier = 0.7;
        break;
      case EventPriority.NORMAL:
        priorityMultiplier = 1.0;
        break;
      case EventPriority.LOW:
        priorityMultiplier = 1.5; // Longer debounce for low priority
        break;
    }

    const finalWindow = Math.round(
      baseWindow * complexityMultiplier * priorityMultiplier,
    );

    // Enforce minimum and maximum bounds
    const minWindow = layer === ProcessingLayer.ATOMIC ? 50 : 1000;
    const maxWindow = layer === ProcessingLayer.CRON ? 3600000 : 60000; // 1h max for cron, 1min for others

    return Math.max(minWindow, Math.min(maxWindow, finalWindow));
  }

  /**
   * Calculate optimal batch size for batch processing
   */
  private calculateBatchSize(
    complexity: SegmentComplexityMetrics,
    contactCount: number,
  ): number {
    let baseBatchSize = 1000; // Default batch size

    // Adjust based on complexity
    if (complexity.hasTimeConstraints) baseBatchSize *= 0.5; // More complex queries
    if (complexity.hasCustomAttributes) baseBatchSize *= 0.7;
    if (complexity.hasPerformedEvents) baseBatchSize *= 0.6;
    if (complexity.nodeCount > 8) baseBatchSize *= 0.8;

    // Adjust based on total contact count
    if (contactCount > 100000) baseBatchSize *= 0.5; // Smaller batches for large segments
    if (contactCount < 1000) baseBatchSize *= 2; // Larger batches for small segments

    // Enforce reasonable bounds
    const finalBatchSize = Math.round(baseBatchSize);
    return Math.max(50, Math.min(5000, finalBatchSize));
  }

  /**
   * Estimate processing time based on layer and complexity
   */
  private estimateProcessingTime(
    layer: ProcessingLayer,
    complexity: SegmentComplexityMetrics,
    contactCount: number,
  ): number {
    let baseTime: number;

    // Base processing times by layer
    switch (layer) {
      case ProcessingLayer.ATOMIC:
        baseTime = 200; // 200ms base
        break;
      case ProcessingLayer.BATCH:
        baseTime = 10000; // 10s base
        break;
      case ProcessingLayer.CRON:
        baseTime = 180000; // 3min base
        break;
    }

    // Complexity multipliers
    let multiplier = 1;
    multiplier += (complexity.nodeCount - 1) * 0.1; // Each additional node adds 10%
    if (complexity.hasTimeConstraints) multiplier *= 1.5;
    if (complexity.hasCustomAttributes) multiplier *= 1.2;
    if (complexity.hasPerformedEvents) multiplier *= 1.4;

    // Contact count impact (logarithmic)
    const contactMultiplier = 1 + Math.log10(contactCount / 1000);
    multiplier *= Math.max(1, contactMultiplier);

    return Math.round(baseTime * multiplier);
  }

  /**
   * Generate human-readable reason for processing decision
   */
  private generateDecisionReason(
    baseLayer: ProcessingLayer,
    finalLayer: ProcessingLayer,
    eventPriority: EventPriority,
    complexity: SegmentComplexityMetrics,
  ): string {
    const reasons: string[] = [];

    // Base classification reason
    if (baseLayer === ProcessingLayer.ATOMIC) {
      reasons.push('Simple segment with low complexity');
    } else if (baseLayer === ProcessingLayer.BATCH) {
      reasons.push('Medium complexity segment suitable for batch processing');
    } else {
      reasons.push('Complex segment requiring scheduled processing');
    }

    // Priority adjustments
    if (finalLayer !== baseLayer) {
      if (eventPriority === EventPriority.CRITICAL) {
        reasons.push('upgraded to faster processing due to critical priority');
      } else if (eventPriority === EventPriority.LOW) {
        reasons.push('downgraded to slower processing due to low priority');
      } else {
        reasons.push('adjusted based on system load conditions');
      }
    }

    // Complexity factors
    const complexityFactors: string[] = [];
    if (complexity.hasTimeConstraints)
      complexityFactors.push('time constraints');
    if (complexity.hasCustomAttributes)
      complexityFactors.push('custom attributes');
    if (complexity.hasPerformedEvents) complexityFactors.push('event queries');
    if (complexity.nodeCount > 5)
      complexityFactors.push(`${complexity.nodeCount} nodes`);

    if (complexityFactors.length > 0) {
      reasons.push(`with ${complexityFactors.join(', ')}`);
    }

    return reasons.join(' ');
  }
}
