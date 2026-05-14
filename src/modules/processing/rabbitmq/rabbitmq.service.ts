import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as amqp from 'amqplib';
import { getProcessingConfig } from '../config/processing.config';
import { QueueMode, WriteMode } from '../enums';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(RabbitMQService.name);
  private readonly config = getProcessingConfig();

  private connection: any = null;
  private channel: any = null;

  // RabbitMQ configuration
  private readonly EXCHANGE_NAME =
    this.config.rabbitmq?.exchange || 'evo-campaign-events';
  private readonly QUEUE_NAME = this.config.rabbitmq?.queue || 'events-queue';
  private readonly ROUTING_KEY = this.config.rabbitmq?.routingKey || 'event';
  private readonly CONNECTION_URL =
    this.config.rabbitmq?.url || 'amqp://localhost:5672';

  async onModuleInit() {
    if (this.shouldUseRabbitMQ()) {
      await this.connect();
    }
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private shouldUseRabbitMQ(): boolean {
    return (
      this.config.queueMode === QueueMode.RABBITMQ ||
      this.config.writeMode === WriteMode.RABBITMQ
    );
  }

  /**
   * Connect to RabbitMQ and setup exchange/queue
   */
  async connect(): Promise<void> {
    try {
      this.logger.log('Connecting to RabbitMQ...');

      // Create connection
      this.connection = await amqp.connect(this.CONNECTION_URL, {
        heartbeat: 60,
        timeout: 10000,
      });

      // Handle connection events
      this.connection.on('error', (error: Error) => {
        this.logger.error(
          `RabbitMQ connection error: ${error.message}`,
          error.stack,
        );
      });

      this.connection.on('close', () => {
        this.logger.warn('RabbitMQ connection closed');
      });

      // Create channel
      this.channel = await this.connection.createChannel();

      // Setup exchange and queue
      await this.setupTopology();

      this.logger.log('✅ Connected to RabbitMQ successfully');
    } catch (error) {
      this.logger.error(
        `Failed to connect to RabbitMQ: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Setup RabbitMQ topology (exchange, queue, bindings)
   */
  private async setupTopology(): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    try {
      // Create exchange (topic type for flexible routing)
      await this.channel.assertExchange(this.EXCHANGE_NAME, 'topic', {
        durable: true,
        autoDelete: false,
      });

      // Create quorum queue (more robust than classic queues)
      await this.channel.assertQueue(this.QUEUE_NAME, {
        durable: true,
        autoDelete: false,
        arguments: {
          'x-queue-type': 'quorum', // Use quorum queue type
          'x-message-ttl': 7 * 24 * 60 * 60 * 1000, // 7 days TTL
          'x-max-length': 100000, // Max 100k messages
          'x-max-length-bytes': 1073741824, // Max 1GB
          'x-overflow': 'drop-head', // Drop oldest messages when full
          'x-delivery-limit': 3, // Dead letter after 3 failed deliveries
        },
      });

      // Bind queue to exchange
      await this.channel.bindQueue(
        this.QUEUE_NAME,
        this.EXCHANGE_NAME,
        this.ROUTING_KEY,
      );

      // Set QoS for consumers (lower for quorum queues)
      await this.channel.prefetch(5); // Process 5 messages at a time (optimal for quorum queues)

      this.logger.log(
        `Exchange: ${this.EXCHANGE_NAME}, Queue: ${this.QUEUE_NAME}, Routing Key: ${this.ROUTING_KEY}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to setup RabbitMQ topology: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Publish message to RabbitMQ
   */
  async publishMessage(message: any, routingKey?: string): Promise<boolean> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    try {
      const messageBuffer = Buffer.from(JSON.stringify(message));
      const key = routingKey || this.ROUTING_KEY;

      const result = this.channel.publish(
        this.EXCHANGE_NAME,
        key,
        messageBuffer,
        {
          persistent: true, // Make message durable
          timestamp: Date.now(),
          messageId: message.messageId || undefined,
          headers: {
            'event-type': message.eventType,
            'content-type': 'application/json',
          },
        },
      );

      if (result) {
        this.logger.debug(
          `Message published to RabbitMQ: ${message.messageId}`,
        );
      } else {
        this.logger.warn('Message publish returned false (buffer full)');
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to publish message: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Publish batch of messages
   */
  async publishBatch(messages: any[]): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const message of messages) {
      const result = await this.publishMessage(message);
      results.push(result);
    }

    this.logger.log(
      `Published batch of ${messages.length} messages to RabbitMQ`,
    );
    return results;
  }

  /**
   * Setup consumer with callback
   */
  async setupConsumer(
    onMessage: (
      message: any,
      ack: () => void,
      nack: () => void,
    ) => Promise<void>,
    consumerTag?: string,
  ): Promise<string> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    try {
      const result = await this.channel.consume(
        this.QUEUE_NAME,
        async (msg) => {
          if (!msg) {
            return;
          }

          try {
            const messageContent = JSON.parse(msg.content.toString());

            const ack = () => this.channel!.ack(msg);
            const nack = () => this.channel!.nack(msg, false, true); // Requeue message

            await onMessage(messageContent, ack, nack);
          } catch (error) {
            this.logger.error(
              `Error processing RabbitMQ message: ${error.message}`,
              error.stack,
            );
            this.channel!.nack(msg, false, false); // Don't requeue on processing error
          }
        },
        {
          noAck: false, // Require manual acknowledgment
          consumerTag: consumerTag || `evo-campaign-consumer-${Date.now()}`,
          exclusive: false,
        },
      );

      this.logger.log(
        `RabbitMQ consumer setup with tag: ${result.consumerTag}`,
      );
      return result.consumerTag;
    } catch (error) {
      this.logger.error(
        `Failed to setup RabbitMQ consumer: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Cancel consumer
   */
  async cancelConsumer(consumerTag: string): Promise<void> {
    if (!this.channel) {
      return;
    }

    try {
      await this.channel.cancel(consumerTag);
      this.logger.log(`Cancelled RabbitMQ consumer: ${consumerTag}`);
    } catch (error) {
      this.logger.error(`Failed to cancel consumer: ${error.message}`);
    }
  }

  /**
   * Get queue info
   */
  async getQueueInfo(): Promise<any> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    try {
      const queueInfo = await this.channel.checkQueue(this.QUEUE_NAME);
      return {
        queue: this.QUEUE_NAME,
        messageCount: queueInfo.messageCount,
        consumerCount: queueInfo.consumerCount,
      };
    } catch (error) {
      this.logger.error(`Failed to get queue info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from RabbitMQ
   */
  async disconnect(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
        this.logger.log('RabbitMQ channel closed');
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
        this.logger.log('RabbitMQ connection closed');
      }
    } catch (error) {
      this.logger.error(`Error disconnecting from RabbitMQ: ${error.message}`);
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.connection || !this.channel) {
        return false;
      }

      // Try to get queue info as health check
      await this.getQueueInfo();
      return true;
    } catch (error) {
      this.logger.error(`RabbitMQ health check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      connected: !!this.connection && !!this.channel,
      exchange: this.EXCHANGE_NAME,
      queue: this.QUEUE_NAME,
      routingKey: this.ROUTING_KEY,
      url: this.CONNECTION_URL.replace(/\/\/.*@/, '//***:***@'), // Hide credentials
    };
  }
}
