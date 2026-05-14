import { Injectable } from '@nestjs/common';
import {
  ProcessingLayer,
  SegmentComplexityMetrics,
} from '../../events/types/routing.types';
import { SegmentNode } from '../../segments/types/segment-computation.types';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * Segment Classifier Service
 * Determines optimal processing layer (ATOMIC/BATCH/CRON) based on segment complexity
 * Following SEGMENT_IMPLEMENTATION_TIMELINE.md requirements
 */
@Injectable()
export class SegmentClassifierService {
  private readonly logger = new CustomLoggerService(
    SegmentClassifierService.name,
  );

  /**
   * Classify segment for processing layer based on complexity analysis
   */
  classifySegment(
    segmentDefinition: SegmentNode,
    estimatedContactCount: number,
  ): ProcessingLayer {
    const complexity = this.analyzeComplexity(segmentDefinition);

    this.logger.debug('Classifying segment', {
      nodeCount: complexity.nodeCount,
      estimatedContactCount,
      hasTimeConstraints: complexity.hasTimeConstraints,
      hasCustomAttributes: complexity.hasCustomAttributes,
      hasPerformedEvents: complexity.hasPerformedEvents,
    });

    // ATOMIC layer criteria - must be processed in < 1s
    if (this.shouldUseAtomicLayer(complexity, estimatedContactCount)) {
      return ProcessingLayer.ATOMIC;
    }

    // BATCH layer criteria - processed in 5-30s
    if (this.shouldUseBatchLayer(complexity, estimatedContactCount)) {
      return ProcessingLayer.BATCH;
    }

    // Default to CRON layer for complex/large segments (5-60min)
    return ProcessingLayer.CRON;
  }

  /**
   * Analyze segment definition complexity
   * Based on SEGMENT_ROUTING_STRATEGY_FINAL.md complexity factors
   */
  analyzeComplexity(segmentDefinition: SegmentNode): SegmentComplexityMetrics {
    const nodeCount = this.countNodes(segmentDefinition);
    const hasTimeConstraints = this.hasTimeConstraints(segmentDefinition);
    const hasCustomAttributes = this.hasCustomAttributes(segmentDefinition);
    const hasPerformedEvents = this.hasPerformedEvents(segmentDefinition);
    const estimatedContactCount = this.estimateContactCount(segmentDefinition);

    return {
      nodeCount,
      hasTimeConstraints,
      hasCustomAttributes,
      hasPerformedEvents,
      estimatedContactCount,
    };
  }

  /**
   * Determine if segment should use ATOMIC layer
   * Criteria from timeline: low complexity, fast processing required
   */
  private shouldUseAtomicLayer(
    complexity: SegmentComplexityMetrics,
    contactCount: number,
  ): boolean {
    // ATOMIC layer requirements:
    // - Simple segments with minimal complexity
    // - Low contact count for sub-second processing
    // - No time constraints (avoid complex date calculations)
    return (
      complexity.nodeCount <= 3 &&
      contactCount <= 1000 &&
      !complexity.hasTimeConstraints &&
      !complexity.hasPerformedEvents
    );
  }

  /**
   * Determine if segment should use BATCH layer
   * Criteria from timeline: medium complexity, reasonable contact count
   */
  private shouldUseBatchLayer(
    complexity: SegmentComplexityMetrics,
    contactCount: number,
  ): boolean {
    // BATCH layer requirements:
    // - Medium complexity segments
    // - Reasonable contact count for batch processing
    // - Can handle some time constraints and custom attributes
    return (
      complexity.nodeCount <= 10 &&
      contactCount <= 50000 &&
      // Allow time constraints but limit complexity
      (!complexity.hasTimeConstraints || complexity.nodeCount <= 5)
    );
  }

  /**
   * Count total nodes in segment definition tree
   */
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

  /**
   * Check if segment has time constraints (performed, lastPerformed)
   */
  private hasTimeConstraints(node: SegmentNode): boolean {
    if (node.type === 'lastPerformed' || node.type === 'performed') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasTimeConstraints(child));
    }
    return false;
  }

  /**
   * Check if segment uses custom attributes
   */
  private hasCustomAttributes(node: SegmentNode): boolean {
    if (node.type === 'customAttribute') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasCustomAttributes(child));
    }
    return false;
  }

  /**
   * Check if segment has performed event queries
   */
  private hasPerformedEvents(node: SegmentNode): boolean {
    if (node.type === 'performed' || node.type === 'lastPerformed') {
      return true;
    }
    if (node.children) {
      return node.children.some((child) => this.hasPerformedEvents(child));
    }
    return false;
  }

  /**
   * Estimate contact count based on segment type
   * Used for classification when actual count is not available
   */
  private estimateContactCount(node: SegmentNode): number {
    switch (node.type) {
      case 'everyone':
        return 100000; // All contacts in account
      case 'has_label':
      case 'not_has_label':
        return 5000; // Typical label usage in CRM
      case 'customAttribute':
        return 2000; // Custom attributes are usually selective
      case 'userProperty':
        return 3000; // User properties moderate selectivity
      case 'performed':
      case 'lastPerformed':
        return 1000; // Specific behavior events are selective
      case 'and':
        // Intersection reduces count (most restrictive child)
        if (node.children && node.children.length > 0) {
          return Math.min(
            ...node.children.map((child) => this.estimateContactCount(child)),
          );
        }
        return 1000;
      case 'or':
        // Union increases count (sum of children, capped)
        if (node.children && node.children.length > 0) {
          const sum = node.children.reduce(
            (total, child) => total + this.estimateContactCount(child),
            0,
          );
          return Math.min(sum, 100000); // Cap at total account size
        }
        return 1000;
      default:
        return 1000; // Conservative default
    }
  }

  /**
   * Get segment complexity score for monitoring/debugging
   */
  getComplexityScore(segmentDefinition: SegmentNode): number {
    const complexity = this.analyzeComplexity(segmentDefinition);
    let score = 0;

    // Base score from node count
    score += complexity.nodeCount * 2;

    // Penalty for complex features
    if (complexity.hasTimeConstraints) score += 10;
    if (complexity.hasCustomAttributes) score += 5;
    if (complexity.hasPerformedEvents) score += 8;

    // Contact count impact (logarithmic scale)
    score += Math.log10(complexity.estimatedContactCount || 1);

    return Math.round(score);
  }
}
