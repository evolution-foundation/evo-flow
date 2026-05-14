import { Injectable, OnModuleInit } from '@nestjs/common';
import { QueueProcessorFactory } from './factories/queue-processor.factory';
import { QueueProcessor } from './interfaces/queue-processor.interface';
import { EventData, ProcessingResult } from './interfaces/event-data.interface';
import { getProcessingConfig } from './config/processing.config';
import { KafkaService } from './kafka/kafka.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * ProcessingService simplificado para modo API
 * Apenas envia eventos para Kafka, sem processamento nem consumers
 */
@Injectable()
export class ApiProcessingService implements OnModuleInit {
  private readonly logger = new CustomLoggerService(ApiProcessingService.name);
  private queueProcessor: QueueProcessor;
  private readonly config = getProcessingConfig();

  constructor(private kafkaService: KafkaService) {}

  async onModuleInit() {
    this.logger.log('Initializing API Processing Service (simplified)...');
    this.logger.log(`Run Mode: ${this.config.runMode}`);
    this.logger.log(`Queue Mode: ${this.config.queueMode}`);
    this.logger.log(`Write Mode: ${this.config.writeMode}`);

    // Initialize queue processor - apenas Kafka producer
    this.queueProcessor = QueueProcessorFactory.create(
      undefined, // sem ClickHouse
      this.kafkaService,
      undefined, // sem RabbitMQ
    );

    // Health check
    const isHealthy = await this.queueProcessor.healthCheck();
    if (!isHealthy) {
      this.logger.warn(
        'Queue processor health check failed during initialization',
      );
    }

    this.logger.log('API Processing Service initialized successfully');
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(
      `Processing event for API: ${eventData.eventType}`,
    );

    try {
      // Apenas envia para Kafka - sem processamento de segmentos
      const result = await this.queueProcessor.processEvent(eventData);

      this.logger.debug(
        `Event sent to queue successfully: ${eventData.messageId}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to process event in API mode: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  getConfig(): Record<string, any> {
    return {
      runMode: this.config.runMode,
      queueMode: this.config.queueMode,
      writeMode: this.config.writeMode,
      description: 'API gateway mode - sends events to Kafka only',
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.queueProcessor.healthCheck();
    } catch (error) {
      this.logger.error(
        `API Processing Service health check failed: ${error.message}`,
      );
      return false;
    }
  }
}
