import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';
import { StorageProcessorFactory } from '../factories/storage-processor.factory';
import { getProcessingConfig } from '../config/processing.config';
import { EventData } from '../interfaces/event-data.interface';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { QueueMode, RunMode } from '../enums';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class RedisConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(RedisConsumerService.name);
  private redis: Redis;
  private storageProcessor;
  private isRunning = false;
  private readonly config = getProcessingConfig();

  constructor(@Optional() private clickhouseService: ClickHouseService) {
    this.redis = new Redis({
      host: this.config.redis?.host || 'localhost',
      port: this.config.redis?.port || 6379,
      password: this.config.redis?.password,
      db: this.config.redis?.db || 0,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      this.logger.log('Redis Consumer connected to Redis');
    });

    this.redis.on('error', (error) => {
      this.logger.error(
        `Redis Consumer connection error: ${error.message}`,
        error.stack,
      );
    });
  }

  async onModuleInit() {
    this.logger.log('Initializing Redis Consumer Service...');

    // Start consuming in EVENT_WORKER mode or SINGLE mode
    const shouldStartConsumer =
      this.config.runMode === RunMode.EVENT_WORKER ||
      this.config.runMode === RunMode.SINGLE;

    if (shouldStartConsumer && this.config.queueMode === QueueMode.REDIS) {
      // Only create StorageProcessor if we have ClickHouse service
      if (this.clickhouseService) {
        this.storageProcessor = StorageProcessorFactory.create(
          this.clickhouseService,
        );
      }
      await this.startConsuming();
    } else {
      this.logger.log(
        `Redis Consumer not started. RunMode: ${this.config.runMode}, QueueMode: ${this.config.queueMode}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.stopConsuming();
  }

  async startConsuming() {
    if (this.isRunning) {
      this.logger.warn('Redis Consumer is already running');
      return;
    }

    try {
      await this.redis.connect();
      this.isRunning = true;

      const queueName = this.config.redis?.queueName || 'evo-campaign-events';
      const concurrency = this.config.workerConcurrency || 5;

      this.logger.log(
        `🔄 Starting Redis Consumer for queue '${queueName}' with concurrency ${concurrency}`,
      );

      // Start multiple workers for concurrency
      for (let i = 0; i < concurrency; i++) {
        this.consumeQueue(queueName, i + 1);
      }
    } catch (error) {
      this.logger.error(
        `Failed to start Redis Consumer: ${error.message}`,
        error.stack,
      );
      this.isRunning = false;
    }
  }

  async stopConsuming() {
    if (!this.isRunning) {
      return;
    }

    this.logger.log('Stopping Redis Consumer...');
    this.isRunning = false;

    if (this.redis) {
      await this.redis.quit();
    }

    this.logger.log('Redis Consumer stopped');
  }

  private async consumeQueue(queueName: string, workerId: number) {
    this.logger.log(`🚀 Worker ${workerId} started for queue '${queueName}'`);

    while (this.isRunning) {
      try {
        // BRPOP blocks until an item is available or timeout (5 seconds)
        const result = await this.redis.brpop(queueName, 5);

        if (result && result.length === 2) {
          const [, eventPayload] = result;
          await this.processEvent(JSON.parse(eventPayload), workerId);
        }
      } catch (error) {
        if (this.isRunning) {
          this.logger.error(
            `Worker ${workerId} error: ${error.message}`,
            error.stack,
          );

          // Wait before retrying to avoid hammering on persistent errors
          await this.delay(this.config.retryDelay || 1000);
        }
      }
    }

    this.logger.log(`🛑 Worker ${workerId} stopped`);
  }

  private async processEvent(eventPayload: any, workerId: number) {
    const startTime = Date.now();

    try {
      const messageId =
        eventPayload.message_id || eventPayload.messageId || 'unknown';

      this.logger.log(
        `🔄 Worker ${workerId} processing Redis event: ${messageId}`,
      );
      this.logger.debug(`Worker ${workerId} full event content:`, eventPayload);

      // Convert Redis message to EventData using same logic as Kafka/RabbitMQ
      const eventData = this.convertToEventData(eventPayload);

      // Process using storage processor
      await this.storageProcessor.saveEvent(eventData);

      const processingTime = Date.now() - startTime;
      this.logger.log(
        `✅ Worker ${workerId} processed Redis event ${eventData.messageId} in ${processingTime}ms`,
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(
        `❌ Worker ${workerId} failed to process Redis event after ${processingTime}ms: ${error.message}`,
        error.stack,
      );

      // TODO: Implement dead letter queue for failed events
      // For now, we'll just log the error and continue
    }
  }

  /**
   * Convert Redis message to EventData format (same as Kafka/RabbitMQ)
   */
  private convertToEventData(payload: any): EventData {
    // Handle both formats: our format and ClickHouse-compatible format
    if (payload.event_type !== undefined) {
      // ClickHouse-compatible format
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

    // Our standard format
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get consumer status (same as Kafka/RabbitMQ)
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      queueMode: this.config.queueMode,
      runMode: this.config.runMode,
      writeMode: this.config.writeMode,
      workersCount: this.config.workerConcurrency || 5,
    };
  }

  async getQueueStats() {
    try {
      const queueName = this.config.redis?.queueName || 'evo-campaign-events';
      const queueLength = await this.redis.llen(queueName);

      return {
        queueName,
        queueLength,
        isRunning: this.isRunning,
        workersCount: this.config.workerConcurrency || 5,
      };
    } catch (error) {
      this.logger.error(`Failed to get queue stats: ${error.message}`);
      return null;
    }
  }
}
