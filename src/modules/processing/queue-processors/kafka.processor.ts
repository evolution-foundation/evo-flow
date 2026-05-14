import { QueueProcessor } from '../interfaces/queue-processor.interface';
import {
  EventData,
  ProcessingResult,
} from '../interfaces/event-data.interface';
import { KafkaService } from '../kafka/kafka.service';
import { getProcessingConfig } from '../config/processing.config';
import { WriteMode } from '../enums/write-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export class KafkaQueueProcessor implements QueueProcessor {
  private readonly logger = new CustomLoggerService(KafkaQueueProcessor.name);
  private readonly config = getProcessingConfig();
  private kafkaService: KafkaService;

  constructor(kafkaService?: KafkaService) {
    if (!kafkaService) {
      throw new Error('KafkaService is required for KafkaQueueProcessor');
    }
    this.kafkaService = kafkaService;
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(`Enqueuing event to Kafka: ${eventData.eventType}`);

    try {
      // For Kafka write mode, send directly to Kafka
      // ClickHouse will consume from Kafka via Kafka Engine table
      if (this.config.writeMode === WriteMode.KAFKA) {
        const kafkaPayload = this.buildKafkaPayload(eventData);
        await this.kafkaService.sendEvent(kafkaPayload);

        return {
          messageId: eventData.messageId,
          status: 'queued',
          queueInfo: {
            queue: this.config.kafka?.topic || 'evo-campaign-events',
            mode: 'kafka',
            writeMode: this.config.writeMode,
          },
        };
      }

      // For other write modes, just queue to Kafka for processing
      await this.kafkaService.sendEvent(eventData);

      return {
        messageId: eventData.messageId,
        status: 'queued',
        queueInfo: {
          queue: this.config.kafka?.topic || 'evo-campaign-events',
          mode: 'kafka',
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to enqueue event to Kafka: ${error.message}`,
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
   * Build Kafka payload format compatible with ClickHouse Kafka Engine
   */
  private buildKafkaPayload(eventData: EventData): any {
    const now = new Date();
    const occurredAt = eventData.timestamp
      ? new Date(eventData.timestamp)
      : now;

    return {
      // Core fields for ClickHouse
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

  getConfig(): Record<string, any> {
    return {
      mode: 'kafka',
      description: 'Sends events to Kafka for processing',
      topic: this.config.kafka?.topic || 'evo-campaign-events',
      brokers: this.config.kafka?.brokers || ['localhost:9092'],
      groupId: this.config.kafka?.groupId || 'evo-campaign-consumers',
      writeMode: this.config.writeMode,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.kafkaService.healthCheck();
    } catch (error) {
      this.logger.error(
        `Kafka processor health check failed: ${error.message}`,
      );
      return false;
    }
  }
}
