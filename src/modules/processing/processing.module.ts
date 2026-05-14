import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ProcessingService } from './processing.service';
import { ProcessingController } from './processing.controller';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { KafkaService } from './kafka/kafka.service';
import { RabbitMQService } from './rabbitmq/rabbitmq.service';
import { RedisConsumerService } from './consumers/redis.consumer';
import { KafkaConsumerService } from './consumers/kafka.consumer';
import { RabbitMQConsumerService } from './consumers/rabbitmq.consumer';
import { AtomicSegmentProcessor } from './services/atomic-processor.service';
import { BatchProcessorService } from './services/batch-processor.service';
import { SingleContactUpdaterService } from './services/single-contact-updater.service';
import { SegmentClassifierService } from './services/segment-classifier.service';
import { ProcessingStrategyService } from './services/processing-strategy.service';
import { IntelligentDebouncerService } from './services/intelligent-debouncer.service';
import { DeadLetterQueueService } from './services/dead-letter-queue.service';
import { BatchDatabaseOptimizerService } from './services/batch-database-optimizer.service';
import { LoadTestingService } from './services/load-testing.service';
import { EnhancedCronSegmentProcessor } from './services/enhanced-cron-segment-processor.service';
import { PrometheusMetrics } from './metrics/prometheus-metrics';
import { Segment } from '../segments/entities/segment.entity';
import { SegmentsModule } from '../segments/segments.module';
import { forwardRef } from '@nestjs/common';
import { RunMode } from './enums/run-mode.enum';
import { getProcessingConfig } from './config/processing.config';

@Module({
  imports: [
    TypeOrmModule.forFeature([Segment]),
    ConfigModule,
    EventEmitterModule.forRoot(),
    forwardRef(() => SegmentsModule),
  ],
  controllers: [ProcessingController],
  providers: [
    ProcessingService,
    {
      provide: ClickHouseService,
      useClass: ClickHouseService,
    },
    KafkaService,
    RabbitMQService,
    RedisConsumerService,
    KafkaConsumerService,
    RabbitMQConsumerService,
    AtomicSegmentProcessor,
    BatchProcessorService,
    SingleContactUpdaterService,
    SegmentClassifierService,
    ProcessingStrategyService,
    IntelligentDebouncerService,
    DeadLetterQueueService,
    BatchDatabaseOptimizerService,
    LoadTestingService,
    EnhancedCronSegmentProcessor,
    PrometheusMetrics,
  ],
  exports: [
    ProcessingService,
    ClickHouseService,
    KafkaService,
    RabbitMQService,
    RedisConsumerService,
    KafkaConsumerService,
    RabbitMQConsumerService,
    AtomicSegmentProcessor,
    BatchProcessorService,
    SingleContactUpdaterService,
    SegmentClassifierService,
    ProcessingStrategyService,
    IntelligentDebouncerService,
    DeadLetterQueueService,
    BatchDatabaseOptimizerService,
    LoadTestingService,
    EnhancedCronSegmentProcessor,
    PrometheusMetrics,
  ],
})
export class ProcessingModule {}
