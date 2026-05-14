import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { StorageProcessorFactory } from '../factories/storage-processor.factory';
import { getProcessingConfig } from '../config/processing.config';
import { EventData } from '../interfaces/event-data.interface';
import { QueueMode, RunMode } from '../enums';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class RabbitMQConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    RabbitMQConsumerService.name,
  );
  private readonly config = getProcessingConfig();
  private storageProcessor;
  private isRunning = false;
  private consumerTag: string | null = null;

  constructor(
    private rabbitMQService: RabbitMQService,
    @Optional() private clickhouseService: ClickHouseService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing RabbitMQ Consumer Service...');

    // Start consuming in EVENT_WORKER mode or SINGLE mode
    const shouldStartConsumer =
      this.config.runMode === RunMode.EVENT_WORKER ||
      this.config.runMode === RunMode.SINGLE;

    if (shouldStartConsumer && this.config.queueMode === QueueMode.RABBITMQ) {
      // Only create StorageProcessor if we have ClickHouse service
      if (this.clickhouseService) {
        this.storageProcessor = StorageProcessorFactory.create(
          this.clickhouseService,
        );
      }
      await this.start();
    } else {
      this.logger.log('RabbitMQ Consumer not started (not in correct mode)');
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async start() {
    if (this.isRunning) {
      this.logger.warn('RabbitMQ Consumer is already running');
      return;
    }

    try {
      this.logger.log('🔄 Starting RabbitMQ Consumer...');

      // Wait for RabbitMQ service to be ready
      await this.waitForRabbitMQReady();

      this.isRunning = true;

      // Setup consumer with message handler
      this.consumerTag = await this.rabbitMQService.setupConsumer(
        async (message: any, ack: () => void, nack: () => void) => {
          await this.processMessage(message, ack, nack);
        },
        `evo-campaign-consumer-${process.pid}-${Date.now()}`,
      );

      this.logger.log('✅ RabbitMQ Consumer started successfully');
    } catch (error) {
      this.logger.error(
        `Failed to start RabbitMQ Consumer: ${error.message}`,
        error.stack,
      );
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Wait for RabbitMQ service to be ready
   */
  private async waitForRabbitMQReady(maxAttempts = 10): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const isHealthy = await this.rabbitMQService.healthCheck();
        if (isHealthy) {
          this.logger.log('RabbitMQ service is ready');
          return;
        }
      } catch (error) {
        this.logger.debug(
          `RabbitMQ health check failed (attempt ${attempt}/${maxAttempts}): ${error.message}`,
        );
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      }
    }

    throw new Error(`RabbitMQ service not ready after ${maxAttempts} attempts`);
  }

  private async stop() {
    if (!this.isRunning) {
      return;
    }

    this.logger.log('Stopping RabbitMQ Consumer...');
    this.isRunning = false;

    if (this.consumerTag) {
      await this.rabbitMQService.cancelConsumer(this.consumerTag);
      this.consumerTag = null;
    }

    this.logger.log('RabbitMQ Consumer stopped');
  }

  /**
   * Process message from RabbitMQ
   */
  private async processMessage(
    message: any,
    ack: () => void,
    nack: () => void,
  ) {
    const startTime = Date.now();

    try {
      const messageId = message.message_id || message.messageId || 'unknown';

      this.logger.log(`🔄 Processing RabbitMQ message: ${messageId}`);
      this.logger.debug(`Full message content:`, message);

      // Convert RabbitMQ message to EventData
      const eventData = this.convertToEventData(message);

      // Process using storage processor
      await this.storageProcessor.saveEvent(eventData);

      // Acknowledge successful processing
      ack();

      const processingTime = Date.now() - startTime;
      this.logger.log(
        `✅ Processed RabbitMQ message ${eventData.messageId} in ${processingTime}ms`,
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(
        `❌ Failed to process RabbitMQ message after ${processingTime}ms: ${error.message}`,
        error.stack,
      );

      // Decide whether to requeue or discard
      if (this.shouldRetry(error)) {
        this.logger.warn('Requeuing message for retry...');
        nack(); // Requeue the message
      } else {
        this.logger.error(
          'Discarding message (too many failures or permanent error)',
        );
        ack(); // Acknowledge to remove from queue
      }
    }
  }

  /**
   * Convert RabbitMQ message to EventData format
   */
  private convertToEventData(message: any): EventData {
    // Handle both formats: our format and ClickHouse-compatible format
    if (message.event_type !== undefined) {
      // ClickHouse-compatible format from RabbitMQ write mode
      return {
        contactId: message.contact_id,
        anonymousId: message.anonymous_id,
        messageId: message.message_id,
        eventType: message.event_type,
        eventName: message.event_name,
        properties: message.properties,
        traits: message.traits,
        timestamp: message.occurred_at,
        context: message.context,
      };
    }

    // Our standard format
    return {
      contactId: message.contactId,
      anonymousId: message.anonymousId,
      messageId: message.messageId,
      eventType: message.eventType,
      eventName: message.eventName,
      properties: message.properties,
      traits: message.traits,
      timestamp: message.timestamp,
      context: message.context,
    };
  }

  /**
   * Determine if message should be retried based on error type
   */
  private shouldRetry(error: any): boolean {
    // Don't retry on validation errors or permanent failures
    const permanentErrors = [
      'validation failed',
      'invalid format',
      'bad request',
      'unauthorized',
    ];

    const errorMessage = error.message?.toLowerCase() || '';

    // Don't retry permanent errors
    if (permanentErrors.some((msg) => errorMessage.includes(msg))) {
      return false;
    }

    // Retry on temporary errors (connection issues, timeouts, etc.)
    const retryableErrors = [
      'connection',
      'timeout',
      'network',
      'temporary',
      'unavailable',
    ];

    return retryableErrors.some((msg) => errorMessage.includes(msg));
  }

  /**
   * Get consumer status and queue info
   */
  async getStatus() {
    let queueInfo = null;

    try {
      queueInfo = await this.rabbitMQService.getQueueInfo();
    } catch (error) {
      this.logger.warn(`Could not get queue info: ${error.message}`);
    }

    return {
      isRunning: this.isRunning,
      consumerTag: this.consumerTag,
      queueMode: this.config.queueMode,
      runMode: this.config.runMode,
      writeMode: this.config.writeMode,
      queueInfo,
    };
  }

  /**
   * Force reconnect (useful for recovery)
   */
  async reconnect() {
    this.logger.log('Reconnecting RabbitMQ Consumer...');

    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
    await this.start();

    this.logger.log('RabbitMQ Consumer reconnected');
  }
}
