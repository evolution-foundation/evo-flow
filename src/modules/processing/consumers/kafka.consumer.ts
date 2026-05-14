import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import { KafkaService } from '../kafka/kafka.service';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { StorageProcessorFactory } from '../factories/storage-processor.factory';
import { getProcessingConfig } from '../config/processing.config';
import { EventData } from '../interfaces/event-data.interface';
import { SegmentJobService } from '../../segments/services/segment-job.service';
import { SegmentInvalidationService } from '../../segments/services/segment-invalidation.service';
import { QueueMode, RunMode } from '../enums';
import { ProcessingService } from '../processing.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(KafkaConsumerService.name);
  private readonly config = getProcessingConfig();
  private storageProcessor;
  private isRunning = false;

  constructor(
    private kafkaService: KafkaService,
    private clickhouseService: ClickHouseService,
    @Inject(forwardRef(() => ProcessingService))
    private processingService: ProcessingService,
    @Optional() private segmentJobService?: SegmentJobService,
    @Optional() private segmentInvalidationService?: SegmentInvalidationService,
  ) {
    this.logger.log('🔧 KafkaConsumerService constructor called');
    this.logger.log(
      `🔍 Constructor - RunMode: ${this.config.runMode}, QueueMode: ${this.config.queueMode}`,
    );
  }

  async onModuleInit() {
    try {
      this.logger.log('🚀 Initializing Kafka Consumer Service...');
      this.logger.log(
        `🔍 Current RunMode: ${this.config.runMode}, QueueMode: ${this.config.queueMode}`,
      );

      // Create StorageProcessor after ClickHouse service is initialized
      try {
        this.storageProcessor = StorageProcessorFactory.create(
          this.clickhouseService,
          this.segmentJobService,
          this.segmentInvalidationService,
        );
        this.logger.log('✅ StorageProcessor created successfully');
      } catch (error) {
        this.logger.error(
          '❌ Error creating StorageProcessor:',
          error.message,
          error.stack,
        );
        throw error;
      }

      // Start consuming in EVENT_WORKER or SINGLE mode only
      const shouldStartConsumer =
        this.config.runMode === RunMode.EVENT_WORKER ||
        this.config.runMode === RunMode.SINGLE;

      this.logger.log(
        `Should start consumer: ${shouldStartConsumer}, Queue is Kafka: ${this.config.queueMode === QueueMode.KAFKA}`,
      );

      if (shouldStartConsumer && this.config.queueMode === QueueMode.KAFKA) {
        await this.start();
      } else {
        this.logger.log(
          `Kafka Consumer not started - RunMode: ${this.config.runMode}, QueueMode: ${this.config.queueMode}`,
        );
      }
    } catch (error) {
      this.logger.error(
        '❌ Error in KafkaConsumerService onModuleInit:',
        error.message,
        error.stack,
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async start() {
    if (this.isRunning) {
      this.logger.warn('Kafka Consumer is already running');
      return;
    }

    try {
      this.logger.log('🔄 Starting Kafka Consumer...');
      this.isRunning = true;

      // Create consumer with message handler
      await this.kafkaService.createConsumer(
        async (payload: EachMessagePayload) => {
          await this.processMessage(payload);
        },
      );

      this.logger.log('✅ Kafka Consumer started successfully');
    } catch (error) {
      this.logger.error(
        `Failed to start Kafka Consumer: ${error.message}`,
        error.stack,
      );
      this.isRunning = false;
      throw error;
    }
  }

  private async stop() {
    if (!this.isRunning) {
      return;
    }

    this.logger.log('Stopping Kafka Consumer...');
    this.isRunning = false;
    // Kafka service will handle disconnection
    this.logger.log('Kafka Consumer stopped');
  }

  /**
   * Process message from Kafka
   */
  private async processMessage(payload: EachMessagePayload) {
    const { topic, partition, message } = payload;
    const startTime = Date.now();

    try {
      if (!message.value) {
        this.logger.warn('Received empty message from Kafka');
        return;
      }

      const eventPayload = JSON.parse(message.value.toString());

      this.logger.debug(
        `Processing Kafka message from partition ${partition}: ${eventPayload.message_id || eventPayload.messageId}`,
      );

      // Convert Kafka payload to EventData
      const eventData = this.convertToEventData(eventPayload);

      // Process segments only - Kafka ENGINE already saves events to ClickHouse
      await this.processingService.processSegmentsForEvent(eventData);

      const processingTime = Date.now() - startTime;
      this.logger.log(
        `✅ Processed Kafka message ${eventData.messageId} in ${processingTime}ms`,
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(
        `❌ Failed to process Kafka message after ${processingTime}ms: ${error.message}`,
        error.stack,
      );

      // In production, you might want to send to DLQ or retry
      throw error;
    }
  }

  /**
   * Convert Kafka message to EventData format
   */
  private convertToEventData(payload: any): EventData {
    if (payload.event_type !== undefined) {
      return {
        contactId: payload.contact_id,
        anonymousId: payload.anonymous_id,
        messageId: payload.message_id,
        eventType: payload.event_type,
        eventName: payload.event_name,
        properties: payload.properties,
        traits: payload.traits,
        timestamp: payload.occurred_at,
        context: payload.context,
      };
    }

    return {
      contactId: payload.contactId,
      anonymousId: payload.anonymousId,
      messageId: payload.messageId,
      eventType: payload.eventType,
      eventName: payload.eventName,
      properties: payload.properties,
      traits: payload.traits,
      timestamp: payload.timestamp,
      context: payload.context,
    };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      queueMode: this.config.queueMode,
      runMode: this.config.runMode,
      writeMode: this.config.writeMode,
    };
  }
}
