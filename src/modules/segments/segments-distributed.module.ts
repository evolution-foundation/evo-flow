import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { KafkaDistributedService } from './services/kafka-distributed.service';
import { SegmentDistributedJobService } from './services/segment-distributed-job.service';
import { SegmentSchedulerService } from './services/segment-scheduler.service';
import { SegmentComputationConsumer } from './consumers/segment-computation.consumer';
import { SegmentResultsConsumer } from './consumers/segment-results.consumer';
import { Segment } from './entities/segment.entity';
import { ProcessingModule } from '../processing/processing.module';
import { SegmentsCacheModule } from './segments-cache.module';

/**
 * Module for distributed segment computation using Kafka
 * Provides scalable, fault-tolerant segment processing with auto-scaling
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Segment]),
    ConfigModule,
    forwardRef(() => ProcessingModule),
    forwardRef(() => SegmentsCacheModule),
  ],
  providers: [
    // Kafka distributed processing
    KafkaDistributedService,

    // Core distributed services
    SegmentDistributedJobService,
    SegmentSchedulerService,

    // Consumers
    SegmentComputationConsumer,
    SegmentResultsConsumer,
  ],
  exports: [
    KafkaDistributedService,
    SegmentDistributedJobService,
    SegmentSchedulerService,
    SegmentComputationConsumer,
    SegmentResultsConsumer,
  ],
})
export class SegmentsDistributedModule {}
