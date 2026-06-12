import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  Kafka,
  KafkaConfig,
  Producer,
  ProducerConfig,
  Partitioners,
  Admin,
  Consumer,
  SASLOptions,
  EachMessagePayload,
} from 'kafkajs';
import { createHash } from 'crypto';
import { getProcessingConfig } from '../config/processing.config';
import { QueueMode, WriteMode } from '../enums';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

// Import Snappy compression for KafkaJS
const SnappyCodec = require('kafkajs-snappy');

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(KafkaService.name);
  private readonly config = getProcessingConfig();

  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;

  // Partition metrics for monitoring
  private partitionMetrics = {
    totalEvents: 0,
    partitionDistribution: new Map<number, number>(), // partition -> event count
    lastResetTime: Date.now(),
  };

  // Kafka configuration
  private readonly CLIENT_ID = 'evo-campaign';
  private readonly TOPIC_NAME =
    this.config.kafka?.topic || 'evo-campaign-events';
  private readonly GROUP_ID =
    this.config.kafka?.groupId || 'evo-campaign-consumers';
  private readonly PARTITIONS = this.config.kafka?.partitions || 12; // 🚀 Increased from 3 to 12 for better throughput
  private readonly TOPIC_REPLICATION_FACTOR =
    this.config.kafka?.replicationFactor || 1;
  private readonly TOPIC_RETENTION_MS =
    this.config.kafka?.topicConfig?.retentionMs || '86400000';
  private readonly TOPIC_RETENTION_BYTES =
    this.config.kafka?.topicConfig?.retentionBytes || '64424509440';
  private readonly TOPIC_COMPRESSION_TYPE =
    this.config.kafka?.topicConfig?.compressionType || 'gzip';
  private readonly TOPIC_MAX_MESSAGE_BYTES =
    this.config.kafka?.topicConfig?.maxMessageBytes || '10485760';

  constructor() {
    this.logger.log('🔧 KafkaService constructor called');
    this.logger.log(
      `🔍 Config - QueueMode: ${this.config.queueMode}, WriteMode: ${this.config.writeMode}`,
    );
  }

  async onModuleInit() {
    this.logger.log('🔧 KafkaService onModuleInit called');
    this.logger.log(
      `🔍 Config - QueueMode: ${this.config.queueMode}, WriteMode: ${this.config.writeMode}`,
    );

    if (this.shouldUseKafka()) {
      this.logger.log('✅ shouldUseKafka() returned true, initializing...');
      await this.initialize();
    } else {
      this.logger.log(
        '❌ shouldUseKafka() returned false, skipping initialization',
      );
    }
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private shouldUseKafka(): boolean {
    return (
      this.config.queueMode === QueueMode.KAFKA ||
      this.config.writeMode === WriteMode.KAFKA
    );
  }

  /**
   * Initialize Kafka client
   */
  private async initialize() {
    try {
      this.logger.log('Initializing Kafka service...');

      // Create Kafka instance
      this.kafka = this.createKafkaInstance();

      // Create admin client for topic management
      this.admin = this.kafka.admin();
      await this.admin.connect();

      // Ensure topic exists
      await this.ensureTopicExists();

      // Initialize producer
      await this.initializeProducer();

      this.logger.log('✅ Kafka service initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Kafka: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Create Kafka instance with configuration
   */
  private createKafkaInstance(): Kafka {
    this.logger.log(`🔍 DEBUG - KafkaService - this.config.kafka: ${JSON.stringify(this.config.kafka)}`);
    this.logger.log(`🔍 DEBUG - KafkaService - this.config.kafka?.brokers: ${this.config.kafka?.brokers}`);
    
    const brokers = this.config.kafka?.brokers || ['localhost:9092'];
    this.logger.log(`🔍 DEBUG - KafkaService - Final brokers value: ${JSON.stringify(brokers)}`);

    // SASL configuration if provided
    const sasl: SASLOptions | undefined = this.getSaslConfig();

    const kafkaConfig: KafkaConfig = {
      clientId: this.CLIENT_ID,
      brokers,
      ssl: !!process.env.KAFKA_SSL,
      sasl,
      connectionTimeout: parseInt(process.env.KAFKA_CONNECTION_TIMEOUT || '10000', 10),
      requestTimeout: parseInt(process.env.KAFKA_REQUEST_TIMEOUT || '30000', 10),
      retry: {
        initialRetryTime: 100,
        retries: parseInt(process.env.KAFKA_RETRIES || '8', 10),
      },
    };

    this.logger.debug('Kafka config:', {
      clientId: kafkaConfig.clientId,
      brokers: kafkaConfig.brokers,
      ssl: kafkaConfig.ssl,
      sasl: !!kafkaConfig.sasl,
    });

    const kafka = new Kafka(kafkaConfig);

    // Register Snappy codec for compression support
    try {
      SnappyCodec(kafka);
      this.logger.debug('Snappy compression codec registered successfully');
    } catch (error) {
      this.logger.warn(
        'Failed to register Snappy codec, disabling compression:',
        error.message,
      );
    }

    return kafka;
  }

  /**
   * Get SASL configuration if credentials are provided
   */
  private getSaslConfig(): SASLOptions | undefined {
    const username = process.env.KAFKA_USERNAME;
    const password = process.env.KAFKA_PASSWORD;

    if (username && password) {
      return {
        mechanism: 'plain', // or 'scram-sha-256', 'scram-sha-512'
        username,
        password,
      };
    }

    return undefined;
  }

  /**
   * Ensure Kafka topic exists
   */
  private async ensureTopicExists() {
    try {
      const topics = await this.admin!.listTopics();

      if (!topics.includes(this.TOPIC_NAME)) {
        this.logger.log(`Creating Kafka topic: ${this.TOPIC_NAME}`);

        await this.admin!.createTopics({
          topics: [
            {
              topic: this.TOPIC_NAME,
              numPartitions: this.PARTITIONS,
              replicationFactor: this.TOPIC_REPLICATION_FACTOR,
              configEntries: [
                { name: 'retention.ms', value: this.TOPIC_RETENTION_MS },
                {
                  name: 'retention.bytes',
                  value: this.TOPIC_RETENTION_BYTES,
                },
                { name: 'compression.type', value: this.TOPIC_COMPRESSION_TYPE },
                {
                  name: 'max.message.bytes',
                  value: this.TOPIC_MAX_MESSAGE_BYTES,
                },
              ],
            },
          ],
        });

        this.logger.log(`✅ Created Kafka topic: ${this.TOPIC_NAME}`);
      } else {
        this.logger.log(`Topic ${this.TOPIC_NAME} already exists`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to ensure topic exists: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Initialize Kafka producer
   */
  private async initializeProducer() {
    const producerConfig: ProducerConfig = {
      createPartitioner: Partitioners.DefaultPartitioner,
      maxInFlightRequests: 5,
      idempotent: true,
      transactionalId: undefined, // Enable for exactly-once semantics
      retry: {
        retries: 5,
      },
      // Compression is configured at topic level, not producer level
    };

    this.producer = this.kafka!.producer(producerConfig);
    await this.producer.connect();

    this.logger.log('Kafka producer connected');
  }

  /**
   * Generate partition key based on contactId (single-account mode)
   * Ensures events from the same contact go to the same partition for ordered processing
   */
  private generatePartitionKey(event: any): string {
    const contactId =
      event.contactId || event.userId || event.anonymousId || 'anonymous';

    // Use SHA-256 hash to ensure even distribution across partitions
    const hash = createHash('sha256').update(contactId).digest('hex');

    this.logger.debug(
      `Generated partition key for contact=${contactId} → hash=${hash.substring(0, 8)}...`,
    );

    return hash;
  }

  /**
   * Record partition metrics for monitoring distribution
   */
  private recordPartitionMetrics(event: any, sendResult: any): void {
    try {
      const partition = sendResult[0]?.partition;
      if (partition !== undefined) {
        // Update partition distribution
        const currentCount =
          this.partitionMetrics.partitionDistribution.get(partition) || 0;
        this.partitionMetrics.partitionDistribution.set(
          partition,
          currentCount + 1,
        );

        this.partitionMetrics.totalEvents++;

        // Log partition distribution every 10000 events (reduced frequency to avoid memory issues)
        // Only log at debug level to reduce memory consumption
        if (this.partitionMetrics.totalEvents % 10000 === 0) {
          this.logPartitionStats();
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to record partition metrics: ${error.message}`);
    }
  }

  /**
   * Log partition distribution stats for monitoring
   */
  private logPartitionStats(): void {
    const partitionCounts = Array.from(
      this.partitionMetrics.partitionDistribution.entries(),
    )
      .sort(([a], [b]) => a - b)
      .map(([partition, count]) => `P${partition}:${count}`)
      .join(' ');

    this.logger.debug(
      `Partition distribution (${this.partitionMetrics.totalEvents} events): ${partitionCounts}`,
    );
  }

  /**
   * Send event to Kafka
   */
  async sendEvent(event: any): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka producer not initialized');
    }

    try {
      // 🚀 Use account-based partitioning for multi-tenant isolation
      const partitionKey = this.generatePartitionKey(event);

      const message = {
        key: partitionKey,
        value: JSON.stringify(event),
        headers: {
          'event-type': String(event.eventType || 'unknown'),
          'contact-id': String(
            event.contactId || event.userId || event.anonymousId || 'anonymous',
          ),
          'partition-strategy': 'contact-based',
          timestamp: new Date().toISOString(),
        },
      };

      const result = await this.producer.send({
        topic: this.TOPIC_NAME,
        messages: [message],
      });

      // 🚀 Record partition metrics
      this.recordPartitionMetrics(event, result);

      this.logger.debug(
        `Event sent to Kafka: ${event.messageId} → partition=${result[0].partition}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send event to Kafka: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Send batch of events to Kafka
   */
  async sendBatch(events: any[]): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka producer not initialized');
    }

    try {
      // 🚀 Use account-based partitioning for each event in the batch
      const messages = events.map((event) => {
        const partitionKey = this.generatePartitionKey(event);

        return {
          key: partitionKey,
          value: JSON.stringify(event),
          headers: {
            'event-type': String(event.eventType || 'unknown'),
            'contact-id': String(
              event.contactId ||
                event.userId ||
                event.anonymousId ||
                'anonymous',
            ),
            'partition-strategy': 'contact-based',
            timestamp: new Date().toISOString(),
          },
        };
      });

      await this.producer.send({
        topic: this.TOPIC_NAME,
        messages,
      });

      this.logger.log(`Batch of ${events.length} events sent to Kafka`);
    } catch (error) {
      this.logger.error(
        `Failed to send batch to Kafka: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Create consumer for processing events
   */
  async createConsumer(
    onMessage: (payload: EachMessagePayload) => Promise<void>,
  ) {
    if (!this.shouldUseKafka()) {
      this.logger.warn('Kafka not enabled, skipping consumer creation');
      return;
    }

    if (!this.kafka) {
      this.logger.error('Kafka not initialized, cannot create consumer');
      throw new Error('Kafka service not initialized');
    }

    // Kafka broker requires:
    // - sessionTimeout >= 6000ms (group.min.session.timeout.ms)
    // - sessionTimeout <= 300000ms (group.max.session.timeout.ms)
    // - heartbeatInterval <= sessionTimeout / 3
    this.consumer = this.kafka.consumer({
      groupId: this.GROUP_ID,
      sessionTimeout: 30000, // 30s - within broker limits
      heartbeatInterval: 3000, // 3s - must be <= sessionTimeout / 3
      maxBytesPerPartition: 1048576, // 1MB
      retry: {
        retries: 5,
      },
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.TOPIC_NAME,
      fromBeginning: false,
    });

    await this.consumer.run({
      autoCommit: true,
      autoCommitInterval: 5000,
      eachMessage: onMessage,
    });

    this.logger.log(`Kafka consumer started for topic: ${this.TOPIC_NAME}`);
  }

  /**
   * Disconnect all Kafka clients
   */
  async disconnect() {
    try {
      if (this.producer) {
        await this.producer.disconnect();
        this.logger.log('Kafka producer disconnected');
      }

      if (this.consumer) {
        await this.consumer.disconnect();
        this.logger.log('Kafka consumer disconnected');
      }

      if (this.admin) {
        await this.admin.disconnect();
        this.logger.log('Kafka admin disconnected');
      }
    } catch (error) {
      this.logger.error(`Error disconnecting Kafka: ${error.message}`);
    }
  }

  /**
   * Get Kafka status with partition metrics
   */
  async getStatus() {
    return {
      connected: !!this.producer,
      topic: this.TOPIC_NAME,
      groupId: this.GROUP_ID,
      partitions: this.PARTITIONS,
      brokers: this.config.kafka?.brokers || ['localhost:9092'],
      // 🚀 Account-based partitioning metrics
      partitioning: this.getPartitioningMetrics(),
    };
  }

  /**
   * Get detailed partitioning metrics for monitoring
   */
  getPartitioningMetrics() {
    const partitionDistribution = Object.fromEntries(
      this.partitionMetrics.partitionDistribution,
    );

    // Calculate partition balance score (0-100, 100 = perfect balance)
    const partitionCounts = Array.from(
      this.partitionMetrics.partitionDistribution.values(),
    );
    const avgEventsPerPartition =
      this.partitionMetrics.totalEvents / this.PARTITIONS;
    const maxVariance = Math.max(
      ...partitionCounts.map((count) =>
        Math.abs(count - avgEventsPerPartition),
      ),
    );
    const balanceScore =
      avgEventsPerPartition > 0
        ? Math.max(0, 100 - (maxVariance / avgEventsPerPartition) * 100)
        : 100;

    return {
      strategy: 'contact-based',
      totalEvents: this.partitionMetrics.totalEvents,
      partitionDistribution,
      balanceScore: Math.round(balanceScore),
      uptimeHours:
        Math.round(
          ((Date.now() - this.partitionMetrics.lastResetTime) / 3600000) * 100,
        ) / 100,
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.admin) {
        return false;
      }

      await this.admin.listTopics();
      return true;
    } catch (error) {
      this.logger.error(`Kafka health check failed: ${error.message}`);
      return false;
    }
  }
}
