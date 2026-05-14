import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';
import { SegmentsStatusController } from './segments-status.controller';
import { Segment } from './entities/segment.entity';
import { SegmentJobService } from './services/segment-job.service';
import { SegmentApiGuard } from './guards/segment-api.guard';
import { SegmentsDistributedModule } from './segments-distributed.module';
import { SegmentsDistributedController } from './segments-distributed.controller';
import { SegmentDistributedJobService } from './services/segment-distributed-job.service';
import { SegmentCacheService } from '../cache/services/segment-cache.service';
import { initializeServiceLocator } from './services/service-locator';

/**
 * Módulo de segmentos simplificado para modo API
 * Sem processamento, apenas CRUD e gerenciamento
 */
@Module({
  imports: [
    ConfigModule,
    SegmentsDistributedModule, // Para endpoints distribuídos
    TypeOrmModule.forFeature([Segment]),
  ],
  controllers: [
    SegmentsController,
    SegmentsStatusController,
    SegmentsDistributedController,
  ],
  providers: [
    SegmentsService,
    SegmentJobService, // Apenas para endpoints, crons desabilitados no modo API
    SegmentApiGuard,
    SegmentDistributedJobService,
  ],
  exports: [SegmentsService, SegmentJobService],
})
export class ApiSegmentsModule implements OnModuleInit {
  constructor(
    private segmentCacheService: SegmentCacheService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    // Initialize service locator for TypeORM entity listeners
    initializeServiceLocator(this.segmentCacheService, this.eventEmitter);
  }
}
