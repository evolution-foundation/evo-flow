import { Injectable } from '@nestjs/common';
import { Segment } from '../entities/segment.entity';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { DeletedContactsCacheService } from './deleted-contacts-cache.service';
import { SegmentCircuitBreakerService } from './segment-circuit-breaker.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import { SegmentStateManagementService } from './segment-state-management.service';
import { SegmentChangeDetectionService } from './segment-change-detection.service';
import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { SegmentQueryExecutionService } from './segment-query-execution.service';
import { SegmentAssignmentService } from './segment-assignment.service';
import { getProcessingConfig } from '../../processing/config/processing.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentComputationResult {
  segmentId: string;
  contactsAdded: number;
  contactsRemoved: number;
  totalContacts: number;
  processingTimeMs: number;
}

@Injectable()
export class ModularSegmentComputationService {
  private readonly logger = new CustomLoggerService(
    ModularSegmentComputationService.name,
  );

  private readonly config = getProcessingConfig();

  constructor(
    private readonly clickHouseService: ClickHouseService,
    private readonly deletedContactsCache: DeletedContactsCacheService,
    private readonly circuitBreaker: SegmentCircuitBreakerService,
    private readonly metrics: SegmentMetricsService,
    private readonly stateManagement: SegmentStateManagementService,
    private readonly changeDetection: SegmentChangeDetectionService,
    private readonly queryBuilder: SegmentClickHouseQueryBuilderService,
    private readonly queryExecution: SegmentQueryExecutionService,
    private readonly assignmentService: SegmentAssignmentService,
  ) {}

  /**
   * Computes multiple segments in batch with resilience features
   */
  async computeSegmentsBatch(
    segments: Segment[],
  ): Promise<SegmentComputationResult[]> {
    const startTime = Date.now();
    const config = this.config.segmentComputation;
    const BATCH_SIZE = config?.batchSize || 20;
    const MAX_CONCURRENCY = config?.maxConcurrency || 5;

    // Record batch metrics
    this.metrics.recordBatchSize(segments.length);
    this.metrics.recordSegmentComputationAttempt({
      operation: 'batch_computation',
    });

    this.logger.log(
      `Computing ${segments.length} segments in batch using optimized pipeline with parallelism (batch size: ${BATCH_SIZE}, concurrency: ${MAX_CONCURRENCY})`,
    );

    const results: SegmentComputationResult[] = [];

    // Pre-warm deleted contacts cache (single-account)
    await this.deletedContactsCache.getDeletedContacts();
    this.logger.debug(`Cache warmed up for deleted contacts`);

    // Split segments into batches
    const batches: Segment[][] = [];
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      batches.push(segments.slice(i, i + BATCH_SIZE));
    }

    // Process batches with controlled concurrency
    for (const batch of batches) {
      const batchPromises = batch.map(async (segment) => {
        const segmentStartTime = Date.now();
        try {
          // Wrap computation with circuit breaker if enabled
          if (config?.circuitBreakerEnabled !== false) {
            const result = await this.circuitBreaker.execute(
              async () => await this.computeSegmentSingle(segment),
              `segment-computation-${segment.id}`,
            );

            // Record success metrics
            this.metrics.recordSegmentComputationDuration(
              Date.now() - segmentStartTime,
              {
                segmentId: segment.id,
                status: 'success',
              },
            );

            return result;
          } else {
            const result = await this.computeSegmentSingle(segment);

            // Record success metrics
            this.metrics.recordSegmentComputationDuration(
              Date.now() - segmentStartTime,
              {
                segmentId: segment.id,
                status: 'success',
              },
            );

            return result;
          }
        } catch (error) {
          // Record failure metrics
          this.metrics.recordSegmentComputationFailure({
            segmentId: segment.id,
            operation: 'segment_computation',
            errorType:
              error instanceof Error
                ? error.constructor.name
                : 'UnknownError',
          });

          this.metrics.recordSegmentComputationDuration(
            Date.now() - segmentStartTime,
            {
              segmentId: segment.id,
              status: 'failure',
            },
          );

          this.logger.error(
            `Failed to compute segment ${segment.id}: ${(error as Error).message}`,
          );
          return {
            segmentId: segment.id,
            contactsAdded: 0,
            contactsRemoved: 0,
            totalContacts: 0,
            processingTimeMs: Date.now() - segmentStartTime,
          };
        }
      });

      // Execute with limited concurrency
      const semaphore = new Array(MAX_CONCURRENCY).fill(null);
      const batchResults = await Promise.all(
        batchPromises.map(async (promise, index) => {
          const semaphoreIndex = index % MAX_CONCURRENCY;
          await semaphore[semaphoreIndex]; // Wait for slot
          semaphore[semaphoreIndex] = promise.then(() => {}); // Reserve slot
          return promise;
        }),
      );

      results.push(...batchResults);

      this.logger.debug(
        `Completed batch of ${batch.length} segments`,
      );
    }

    const totalDuration = Date.now() - startTime;

    // Record overall batch metrics
    this.metrics.recordSegmentComputationDuration(totalDuration, {
      segmentId: 'batch',
      status: 'success',
    });

    this.logger.log(
      `Batch computation completed: ${results.length} segments processed in ${totalDuration}ms`,
    );
    return results;
  }

  async computeSegment(segment: Segment): Promise<SegmentComputationResult> {
    return this.computeSegmentSingle(segment);
  }

  /**
   * Main computation logic - EXACTLY like backup but using modular builders
   */
  private async computeSegmentSingle(
    segment: Segment,
  ): Promise<SegmentComputationResult> {
    const startTime = Date.now();
    const now = Date.now();

    this.logger.log(
      `Computing segment ${segment.name} (${segment.id}) using optimized pipeline`,
    );

    if (!segment.definition || !('entryNode' in segment.definition)) {
      this.logger.warn(
        `Segment ${segment.id} has no definition, skipping computation`,
      );
      return {
        segmentId: segment.id,
        contactsAdded: 0,
        contactsRemoved: 0,
        totalContacts: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    try {
      // Debug: check event count
      const checkQuery = `SELECT count(*) as total FROM evo_campaign.contact_events`;
      const eventCount = await this.clickHouseService.query({
        query: checkQuery,
      });

      this.logger.debug(
        `Found ${eventCount[0]?.total || 0} events`,
      );

      const definition = segment.definition;

      // For segments with time windows, preserve previous state before cleaning
      const hasTimeWindows =
        this.queryExecution.segmentHasTimeWindows(definition);

      // For time windows segments, get previous assignments BEFORE cleanup for event detection
      // IMPORTANT: Must be done BEFORE cleanupOldSegmentData!
      let previousAssignmentsForTimeWindows: Record<string, boolean> = {};
      if (hasTimeWindows) {
        this.logger.debug(
          `Segment ${segment.id} has time windows - preserving previous assignments BEFORE cleanup`,
        );

        // Get assignments from last computation BEFORE cleaning data
        previousAssignmentsForTimeWindows =
          await this.stateManagement.getPreviousSegmentAssignments(segment.id);

        this.logger.debug(
          `Preserved ${Object.keys(previousAssignmentsForTimeWindows).length} previous assignments for segment ${segment.id} before cleanup`,
        );

        // Now we can safely clean up old data
        this.logger.log(
          `Cleaning up old ClickHouse data for segment ${segment.id} (after preserving state)`,
        );
        await this.stateManagement.cleanupOldSegmentData(segment.id);
      }

      // STAGE 1: Compute States
      await this.computeState(segment, definition, now);

      // STAGE 2: Compute Assignments
      await this.assignmentService.computeAssignments(segment, definition, now);

      // STAGE 3: Process segment change events BEFORE saving new state
      // This ensures we compare with the REAL previous state
      await this.changeDetection.processSegmentChangeEvents(
        segment,
        now,
        hasTimeWindows ? previousAssignmentsForTimeWindows : undefined,
      );

      // STAGE 4: Save resolved segment state (AFTER events are processed)
      // This will overwrite previous state in ReplacingMergeTree
      await this.stateManagement.saveResolvedSegmentState(segment, now);

      // Count final results
      const result = await this.assignmentService.countFinalAssignments(
        segment.id,
      );

      this.logger.log(
        `Segment computation completed: ${result.contactsAdded} added, ` +
          `${result.contactsRemoved} removed, ${result.totalContacts} total (${Date.now() - startTime}ms)`,
      );

      return {
        segmentId: segment.id,
        ...result,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error(
        `Failed to compute segment ${segment.id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * STAGE 1: Compute States - Using modular builders but same pipeline
   */
  async computeState(
    segment: Segment,
    definition: any,
    now: number,
  ): Promise<void> {
    this.logger.debug(
      `[STAGE 1] Computing states for segment ${segment.id} (incremental mode)`,
    );

    // Validate inputs
    if (!segment || !segment.id) {
      throw new Error(`Invalid segment object: ${JSON.stringify(segment)}`);
    }

    if (!definition || !definition.entryNode) {
      throw new Error(
        `Invalid segment definition for segment ${segment.id}: ${JSON.stringify(definition)}`,
      );
    }

    // Use modular builders to create state sub-queries
    const subQueryData = this.queryBuilder.segmentNodeToStateSubQuery(
      segment,
      definition.entryNode,
      definition,
    );

    if (subQueryData.length === 0) {
      this.logger.debug(`No sub-queries generated for segment ${segment.id}`);
      return;
    }

    this.logger.debug(
      `Generated ${subQueryData.length} sub-queries for segment ${segment.id}:`,
      JSON.stringify(subQueryData, null, 2),
    );

    // Execute state computation
    await this.queryExecution.executeStateComputation(segment, subQueryData, now);
  }

  /**
   * Delegation methods for backward compatibility
   */
  async cleanupOldSegmentData(segmentId: string): Promise<void> {
    return this.stateManagement.cleanupOldSegmentData(segmentId);
  }

  async computeAssignments(
    segment: Segment,
    definition: any,
    now: number,
  ): Promise<void> {
    return this.assignmentService.computeAssignments(segment, definition, now);
  }

  async countFinalAssignments(segmentId: string): Promise<{
    contactsAdded: number;
    contactsRemoved: number;
    totalContacts: number;
  }> {
    return this.assignmentService.countFinalAssignments(segmentId);
  }
}
