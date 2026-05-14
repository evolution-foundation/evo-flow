import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { QueueProcessorFactory } from './factories/queue-processor.factory';
import { QueueProcessor } from './interfaces/queue-processor.interface';
import { EventData, ProcessingResult } from './interfaces/event-data.interface';
import { getProcessingConfig } from './config/processing.config';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { KafkaService } from './kafka/kafka.service';
import { RabbitMQService } from './rabbitmq/rabbitmq.service';
import { AtomicSegmentProcessor } from './services/atomic-processor.service';
import { BatchProcessorService } from './services/batch-processor.service';
import { SegmentClassifierService } from './services/segment-classifier.service';
import { EnhancedCronSegmentProcessor } from './services/enhanced-cron-segment-processor.service';
import { RunMode } from './enums/run-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class ProcessingService implements OnModuleInit {
  private readonly logger = new CustomLoggerService(ProcessingService.name);
  private queueProcessor: QueueProcessor;
  private readonly config = getProcessingConfig();

  constructor(
    @Optional() private clickhouseService: ClickHouseService,
    private kafkaService: KafkaService,
    private rabbitMQService: RabbitMQService,
    @Optional() private atomicProcessor: AtomicSegmentProcessor,
    @Optional() private batchProcessor: BatchProcessorService,
    @Optional() private segmentClassifier: SegmentClassifierService,
    @Optional() private enhancedCronProcessor: EnhancedCronSegmentProcessor,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Processing Service...');
    this.logger.log(`Run Mode: ${this.config.runMode}`);
    this.logger.log(`Queue Mode: ${this.config.queueMode}`);
    this.logger.log(`Write Mode: ${this.config.writeMode}`);

    // Initialize queue processor
    this.queueProcessor = QueueProcessorFactory.create(
      this.clickhouseService,
      this.kafkaService,
      this.rabbitMQService,
    );

    // Health check
    const isHealthy = await this.queueProcessor.healthCheck();
    if (!isHealthy) {
      this.logger.warn(
        'Queue processor health check failed during initialization',
      );
    }

    this.logger.log('Processing Service initialized successfully');
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(
      `Processing event: ${eventData.eventType}`,
    );

    try {
      // 🚀 FIRE-AND-FORGET: Envia para Kafka sem aguardar
      const queuePromise = this.queueProcessor.processEvent(eventData);

      // 🚀 Processa segmentos em background (não bloqueia resposta)
      queuePromise
        .then((result) => {
          // Após kafka confirmar, processa segmentos
          this.processSegmentsForEvent(eventData).catch((error) => {
            this.logger.error(
              `Failed to process segments: ${error.message}`,
              error.stack,
            );
          });

          this.logger.debug(
            `Event queued: ${result.messageId} - Status: ${result.status}`,
          );
        })
        .catch((error) => {
          this.logger.error(
            `Failed to queue event: ${error.message}`,
            error.stack,
          );
        });

      // Retorna imediatamente com status "queued"
      return {
        messageId: eventData.messageId,
        status: 'queued',
      };
    } catch (error) {
      this.logger.error(
        `Failed to process event: ${error.message}`,
        error.stack,
      );

      return {
        messageId: eventData.messageId,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Process segments for an event without queue processing
   * Used by Kafka consumer to avoid circular loops
   */
  async processSegmentsForEvent(eventData: EventData): Promise<void> {
    // 🚀 HYBRID SEGMENT PROCESSING: Process segments in SINGLE, EVENT_WORKER, and SEGMENT_WORKER modes
    if (eventData.eventType && eventData.contactId && eventData.eventName) {
      // Check if this instance should process segments
      const shouldProcessSegments =
        this.config.runMode === RunMode.SINGLE ||
        this.config.runMode === RunMode.EVENT_WORKER;

      if (!shouldProcessSegments) {
        this.logger.debug(
          `📤 Segment processing skipped (${this.config.runMode} mode) - event sent to queue for workers`,
        );
        return;
      }

      // 🔒 CHECK ENVIRONMENT CONFIGURATION
      const computationType =
        process.env.SEGMENT_COMPUTATION_TYPE || 'cron-job';

      if (computationType === 'real-time') {
        // Give Kafka→ClickHouse time to ingest the event (ENGINE=Kafka + materialized view)
        setTimeout(async () => {
          try {
            // 🔥 SPRINT 2 & 3: INTELLIGENT HYBRID SEGMENT ROUTING
            this.logger.debug(
              `🤖 Starting hybrid segment processing for event: ${eventData.eventName}`,
            );

            // 1. ATOMIC PROCESSING (< 1s) - Small segments, simple logic
            const atomicPromise = this.atomicProcessor
              .processAtomicUpdate({
                contactId: eventData.contactId!,
                eventName: eventData.eventName!,
                eventTime: eventData.timestamp
                  ? new Date(eventData.timestamp)
                  : new Date(),
                properties: eventData.properties || {},
              })
              .catch((atomicError) => {
                this.logger.error(
                  `AtomicProcessor failed for event ${eventData.messageId}:`,
                  atomicError,
                );
              });

            // 2. BATCH PROCESSING (< 30s) - Medium segments with intelligent buffering
            const batchPromise = this.batchProcessor
              .queueEventForBatchSegmentProcessing(eventData)
              .catch((batchError) => {
                this.logger.error(
                  `BatchProcessor failed for event ${eventData.messageId}:`,
                  batchError,
                );
              });

            // Process both in parallel for maximum throughput
            await Promise.allSettled([atomicPromise, batchPromise]);

            this.logger.debug(
              `✅ Hybrid segment processing completed for event: ${eventData.eventName}`,
            );
          } catch (error) {
            this.logger.error(
              `Hybrid segment processing failed for event ${eventData.messageId}:`,
              error,
            );
          }
        }, 2000); // Wait 2 seconds for Kafka→ClickHouse ingestion
      } else {
        // 🔒 LEGACY MODE: SEGMENT_COMPUTATION_TYPE=cron-job
        this.logger.debug(
          `⏸️ Hybrid processing disabled (SEGMENT_COMPUTATION_TYPE=${computationType}) - Legacy system active`,
        );
        // Legacy segment-job system handles segment processing
      }
    }
  }

  getProcessingInfo() {
    return {
      config: {
        runMode: this.config.runMode,
        queueMode: this.config.queueMode,
        writeMode: this.config.writeMode,
      },
      processor: this.queueProcessor.getConfig(),
      // 🚀 SPRINT 2 & 3: Enhanced processing statistics
      hybridProcessing: {
        atomic: this.atomicProcessor.getProcessingStats
          ? this.atomicProcessor.getProcessingStats()
          : 'Not available',
        batch: this.batchProcessor.getProcessingStats(),
        legacy: this.batchProcessor.getBatchStatus(),
      },
      // 🎯 SPRINT 3: Enhanced CRON segment processing
      enhancedCronProcessing: {
        status: this.enhancedCronProcessor.getSystemStatus(),
        stats: this.enhancedCronProcessor.getProcessingStats(),
      },
    };
  }

  async getHealthStatus() {
    const isHealthy = await this.queueProcessor.healthCheck();

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      config: this.getProcessingInfo(),
      timestamp: new Date().toISOString(),
    };
  }
}
