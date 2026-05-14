import Redis from 'ioredis';
import { QueueProcessor } from '../interfaces/queue-processor.interface';
import {
  EventData,
  ProcessingResult,
} from '../interfaces/event-data.interface';
import { getProcessingConfig } from '../config/processing.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export class RedisQueueProcessor implements QueueProcessor {
  private readonly logger = new CustomLoggerService(RedisQueueProcessor.name);
  private redis: Redis;
  private readonly config = getProcessingConfig();

  constructor() {
    this.redis = new Redis({
      host: this.config.redis?.host || 'localhost',
      port: this.config.redis?.port || 6379,
      password: this.config.redis?.password,
      db: this.config.redis?.db || 0,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      this.logger.log('Connected to Redis');
    });

    this.redis.on('error', (error) => {
      this.logger.error(
        `Redis connection error: ${error.message}`,
        error.stack,
      );
    });

    this.redis.on('reconnecting', () => {
      this.logger.log('Reconnecting to Redis...');
    });
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(`Enqueuing event to Redis: ${eventData.eventType}`);

    try {
      // Ensure connection
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }

      const queueName = this.config.redis?.queueName || 'evo-campaign-events';
      const eventPayload = {
        ...eventData,
        enqueuedAt: new Date().toISOString(),
        queueName,
      };

      // Push event to Redis list (LPUSH for FIFO with BRPOP on consumer)
      await this.redis.lpush(queueName, JSON.stringify(eventPayload));

      this.logger.log(
        `Event enqueued to Redis queue '${queueName}': ${eventData.messageId}`,
      );

      return {
        messageId: eventData.messageId,
        status: 'queued',
        queueInfo: {
          queue: queueName,
          mode: 'redis',
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to enqueue event to Redis: ${error.message}`,
        error.stack,
      );

      return {
        messageId: eventData.messageId,
        status: 'error',
        error: `Redis queue error: ${error.message}`,
      };
    }
  }

  getConfig(): Record<string, any> {
    return {
      mode: 'redis',
      description: 'Enqueues events to Redis for background processing',
      queue: this.config.redis?.queueName || 'evo-campaign-events',
      host: this.config.redis?.host || 'localhost',
      port: this.config.redis?.port || 6379,
      db: this.config.redis?.db || 0,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }

      const result = await this.redis.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error(`Redis health check failed: ${error.message}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.logger.log('Disconnected from Redis');
    }
  }
}
