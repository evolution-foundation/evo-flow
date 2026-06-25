import { Module, forwardRef, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';
import { SegmentsStatusController } from './segments-status.controller';
import { Segment } from './entities/segment.entity';
import { SegmentComputationService } from './services/segment-computation.service';
import { SegmentJobService } from './services/segment-job.service';
import { SegmentModeManagerService } from './services/segment-mode-manager.service';
import { SegmentApiGuard } from './guards/segment-api.guard';
import { ModularSegmentComputationService } from './services/modular-segment-computation.service';
import { SegmentStateManagementService } from './services/segment-state-management.service';
import { SegmentChangeDetectionService } from './services/segment-change-detection.service';
import { SegmentClickHouseQueryBuilderService } from './services/segment-clickhouse-query-builder.service';
import { SegmentQueryExecutionService } from './services/segment-query-execution.service';
import { SegmentAssignmentService } from './services/segment-assignment.service';
import { SegmentEventsService } from './services/segment-events.service';
import { DeletedContactsCacheService } from './services/deleted-contacts-cache.service';
import { SegmentCircuitBreakerService } from './services/segment-circuit-breaker.service';
import { SegmentMetricsService } from './metrics/segment-metrics.service';
import { ProcessingModule } from '../processing/processing.module';
import { SegmentsCacheModule } from './segments-cache.module';
import { SegmentsDistributedModule } from './segments-distributed.module';
import { SegmentsDistributedController } from './segments-distributed.controller';
import { SegmentDistributedJobService } from './services/segment-distributed-job.service';
import { SegmentCacheService } from '../cache/services/segment-cache.service';
import { initializeServiceLocator } from './services/service-locator';

@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot(),
    forwardRef(() => ProcessingModule), // Para acessar ProcessingService
    SegmentsCacheModule,
    SegmentsDistributedModule,
    TypeOrmModule.forFeature([Segment]),
  ],
  controllers: [
    SegmentsController,
    SegmentsStatusController,
    SegmentsDistributedController,
  ],
  providers: [
    SegmentsService,
    SegmentComputationService,
    ModularSegmentComputationService,
    SegmentStateManagementService,
    SegmentChangeDetectionService,
    SegmentClickHouseQueryBuilderService,
    SegmentQueryExecutionService,
    SegmentAssignmentService,
    SegmentEventsService,
    DeletedContactsCacheService,
    SegmentCircuitBreakerService,
    SegmentMetricsService,
    SegmentJobService,
    SegmentModeManagerService,
    SegmentApiGuard,
    SegmentDistributedJobService,
  ],
  exports: [
    SegmentsService,
    SegmentComputationService,
    SegmentJobService,
    SegmentsCacheModule, // Export cache module for other modules to use
  ],
})
export class SegmentsModule implements OnModuleInit {
  constructor(
    private segmentCacheService: SegmentCacheService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    // Initialize service locator for TypeORM entity listeners
    initializeServiceLocator(this.segmentCacheService, this.eventEmitter);
  }
}
