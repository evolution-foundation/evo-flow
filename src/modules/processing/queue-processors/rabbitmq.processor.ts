import { QueueProcessor } from '../interfaces/queue-processor.interface';
import {
  EventData,
  ProcessingResult,
} from '../interfaces/event-data.interface';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import { getProcessingConfig } from '../config/processing.config';
import { WriteMode } from '../enums/write-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export class RabbitMQQueueProcessor implements QueueProcessor {
  private readonly logger = new CustomLoggerService(
    RabbitMQQueueProcessor.name,
  );
  private readonly config = getProcessingConfig();
  private rabbitMQService: RabbitMQService;

  constructor(rabbitMQService?: RabbitMQService) {
    if (!rabbitMQService) {
      throw new Error('RabbitMQService is required for RabbitMQQueueProcessor');
    }
    this.rabbitMQService = rabbitMQService;
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(`Enqueuing event to RabbitMQ: ${eventData.eventType}`);

    try {
      // Build RabbitMQ payload
      const rabbitMQPayload = this.buildRabbitMQPayload(eventData);

      // Determine routing key based on event type
      const routingKey = this.getRoutingKey(eventData);

      // Publish to RabbitMQ
      const success = await this.rabbitMQService.publishMessage(
        rabbitMQPayload,
        routingKey,
      );

      if (!success) {
        throw new Error('Failed to publish message to RabbitMQ (buffer full)');
      }

      return {
        messageId: eventData.messageId,
        status: 'queued',
        queueInfo: {
          queue: this.config.rabbitmq?.queue || 'events-queue',
          mode: 'rabbitmq',
          writeMode: this.config.writeMode,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to enqueue event to RabbitMQ: ${error.message}`,
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
   * Build RabbitMQ payload format
   */
  private buildRabbitMQPayload(eventData: EventData): any {
    const now = new Date();
    const occurredAt = eventData.timestamp
      ? new Date(eventData.timestamp)
      : now;

    // For RabbitMQ write mode (direct to ClickHouse), format like Kafka
    if (this.config.writeMode === WriteMode.RABBITMQ) {
      return {
        // ClickHouse compatible format
        event_type: eventData.eventType,
        event_name: eventData.eventName || eventData.eventType,

        // JSON fields
        properties: eventData.properties || {},
        traits: eventData.traits || {},
        context: eventData.context || {},

        // Identifiers
        contact_id: eventData.contactId,
        anonymous_id: eventData.anonymousId,
        message_id: eventData.messageId,

        // Timestamps
        occurred_at: occurredAt.toISOString(),
        processing_time: now.toISOString(),

        // Full message for debugging
        message_raw: {
          type: eventData.eventType,
          eventName: eventData.eventName,
          properties: eventData.properties,
          traits: eventData.traits,
          timestamp: eventData.timestamp,
          contactId: eventData.contactId,
          anonymousId: eventData.anonymousId,
          context: eventData.context,
          messageId: eventData.messageId,
        },
      };
    }

    // Standard format for processing
    return eventData;
  }

  /**
   * Determine routing key based on event data
   * Allows for flexible message routing in RabbitMQ
   */
  private getRoutingKey(eventData: EventData): string {
    const baseKey = this.config.rabbitmq?.routingKey || 'event';

    // For single queue setup, use the base routing key
    // For more complex routing, could use: `${baseKey}.${eventData.eventType}.${eventData.accountId}`
    return baseKey;
  }

  getConfig(): Record<string, any> {
    return {
      mode: 'rabbitmq',
      description: 'Sends events to RabbitMQ for processing',
      exchange: this.config.rabbitmq?.exchange || 'evo-campaign-events',
      queue: this.config.rabbitmq?.queue || 'events-queue',
      routingKey: this.config.rabbitmq?.routingKey || 'event',
      url: this.config.rabbitmq?.url || 'amqp://localhost:5672',
      writeMode: this.config.writeMode,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.rabbitMQService.healthCheck();
    } catch (error) {
      this.logger.error(
        `RabbitMQ processor health check failed: ${error.message}`,
      );
      return false;
    }
  }
}
