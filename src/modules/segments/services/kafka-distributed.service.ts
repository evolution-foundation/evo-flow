import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  Kafka,
  KafkaConfig,
  Producer,
  Consumer,
  Admin,
  EachMessagePayload,
  SASLOptions,
  Partitioners,
} from 'kafkajs';
import { getProcessingConfig } from '../../processing/config/processing.config';
import { QueueMode, WriteMode } from '../../processing/enums';
import {
  SEGMENT_KAFKA_TOPICS,
  getSegmentKafkaConfig,
} from '../config/kafka-topics.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * Extended Kafka service specifically for distributed segment processing
 * Supports multiple specialized topics and consumer groups
 */
@Injectable()
export class KafkaDistributedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    KafkaDistributedService.name,
  );
  private readonly config = getProcessingConfig();
  private readonly segmentConfig = getSegmentKafkaConfig();

  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private consumers: Map<string, Consumer> = new Map();

  // Kafka configuration
  private readonly CLIENT_ID = 'evo-campaign-distributed';

  async onModuleInit() {
    if (this.shouldUseKafka()) {
      await this.initialize();
    }
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private shouldUseKafka(): boolean {
    return (
      this.config.queueMode === QueueMode.KAFKA ||
      this.config.writeMode === WriteMode.KAFKA ||
      process.env.ENABLE_DISTRIBUTED_PROCESSING === 'true'
    );
  }

  /**
   * Initialize Kafka client with distributed processing support
   */
  private async initialize() {
    try {
      this.logger.log('Initializing distributed Kafka service...');

      // Create Kafka instance
      this.kafka = this.createKafkaInstance();

      // Create admin client for topic management
      this.admin = this.kafka.admin();
      await this.admin.connect();

      // Ensure all segment topics exist
      await this.ensureSegmentTopicsExist();

      // Initialize producer
      await this.initializeProducer();

      this.logger.log('✅ Distributed Kafka service initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize distributed Kafka: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Create Kafka instance with configuration
   */
  private createKafkaInstance(): Kafka {
    this.logger.log(`🔍 DEBUG - this.config.kafka: ${JSON.stringify(this.config.kafka)}`);
    this.logger.log(`🔍 DEBUG - this.config.kafka?.brokers: ${this.config.kafka?.brokers}`);
    
    const brokers = this.config.kafka?.brokers || ['localhost:9092'];
    this.logger.log(`🔍 DEBUG - Final brokers value: ${JSON.stringify(brokers)}`);
    
    const sasl: SASLOptions | undefined = this.getSaslConfig();

    const kafkaConfig: KafkaConfig = {
      clientId: this.CLIENT_ID,
      brokers,
      ssl: !!process.env.KAFKA_SSL,
      sasl,
      connectionTimeout: 3000, // Faster connection for immediate processing
      requestTimeout: 10000, // Reduced timeout for faster failures
      retry: {
        initialRetryTime: 50, // Faster retry
        retries: 3, // Fewer retries for faster processing
      },
    };

    this.logger.debug('Distributed Kafka config:', {
      clientId: kafkaConfig.clientId,
      brokers: kafkaConfig.brokers,
      ssl: kafkaConfig.ssl,
      sasl: !!kafkaConfig.sasl,
    });

    return new Kafka(kafkaConfig);
  }

  /**
   * Get SASL configuration if credentials are provided
   */
  private getSaslConfig(): SASLOptions | undefined {
    const username = process.env.KAFKA_USERNAME;
    const password = process.env.KAFKA_PASSWORD;

    if (username && password) {
      return {
        mechanism: 'plain',
        username,
        password,
      };
    }

    return undefined;
  }

  /**
   * Ensure all segment-related Kafka topics exist
   */
  private async ensureSegmentTopicsExist() {
    try {
      const existingTopics = await this.admin!.listTopics();
      const topicsToCreate: Array<{
        topic: string;
        numPartitions: number;
        replicationFactor: number;
        configEntries: Array<{ name: string; value: string }>;
      }> = [];

      // Check each segment topic
      for (const [key, topicConfig] of Object.entries(SEGMENT_KAFKA_TOPICS)) {
        if (!existingTopics.includes(topicConfig.name)) {
          topicsToCreate.push({
            topic: topicConfig.name,
            numPartitions: topicConfig.partitions,
            replicationFactor: Math.min(topicConfig.replicationFactor, 1), // Limit to 1 for development
            configEntries: [
              { name: 'retention.ms', value: '604800000' }, // 7 days
              { name: 'compression.type', value: 'uncompressed' },
              { name: 'max.message.bytes', value: '10485760' }, // 10MB
              ...Object.entries(topicConfig.config || {}).map(
                ([name, value]) => ({ name, value }),
              ),
            ],
          });

          this.logger.log(`Will create topic: ${topicConfig.name} (${key})`);
        } else {
          this.logger.log(`Topic ${topicConfig.name} already exists`);
        }
      }

      // Create topics if any are missing
      if (topicsToCreate.length > 0) {
        await this.admin!.createTopics({
          topics: topicsToCreate,
        });

        this.logger.log(
          `✅ Created ${topicsToCreate.length} Kafka topics for distributed processing`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to ensure segment topics exist: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Initialize Kafka producer
   */
  private async initializeProducer() {
    this.producer = this.kafka!.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      maxInFlightRequests: 5,
      idempotent: true,
      retry: {
        retries: 5,
      },
    });

    await this.producer.connect();
    this.logger.log('Distributed Kafka producer connected');
  }

  /**
   * Send message to specific topic
   */
  async sendToTopic(
    topicName: string,
    message: any,
    key?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka producer not initialized');
    }

    try {
      await this.producer.send({
        topic: topicName,
        messages: [
          {
            key: key || null,
            value: JSON.stringify(message),
            headers: {
              timestamp: new Date().toISOString(),
              ...headers,
            },
          },
        ],
      });

      this.logger.debug(
        `Message sent to topic ${topicName}: ${key || 'no-key'}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send message to topic ${topicName}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Create specialized consumer for a topic
   */
  async createTopicConsumer(
    topicName: string,
    groupId: string,
    onMessage: (payload: EachMessagePayload) => Promise<void>,
    consumerOptions?: {
      sessionTimeout?: number;
      heartbeatInterval?: number;
      maxBytesPerPartition?: number;
      fromBeginning?: boolean;
    },
  ): Promise<Consumer> {
    if (!this.kafka) {
      throw new Error('Kafka not initialized');
    }

    const consumerId = `${groupId}-${topicName}`;

    if (this.consumers.has(consumerId)) {
      this.logger.warn(
        `Consumer ${consumerId} already exists, returning existing`,
      );
      return this.consumers.get(consumerId)!;
    }

    // Kafka broker requires: 
    // - sessionTimeout >= 6000ms (group.min.session.timeout.ms)
    // - sessionTimeout <= 300000ms (group.max.session.timeout.ms)
    // - heartbeatInterval <= sessionTimeout / 3
    const defaultSessionTimeout = 30000; // 30s - safe default within broker limits
    const defaultHeartbeatInterval = 3000; // 3s - must be <= sessionTimeout / 3
    
    const sessionTimeout = consumerOptions?.sessionTimeout || defaultSessionTimeout;
    const heartbeatInterval = consumerOptions?.heartbeatInterval || defaultHeartbeatInterval;
    
    // Validate heartbeat interval (must be <= sessionTimeout / 3)
    const maxHeartbeatInterval = Math.floor(sessionTimeout / 3);
    const validHeartbeatInterval = Math.min(heartbeatInterval, maxHeartbeatInterval);
    
    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout, // Within broker limits (6s - 5min)
      heartbeatInterval: validHeartbeatInterval, // Must be <= sessionTimeout / 3
      maxBytesPerPartition: consumerOptions?.maxBytesPerPartition || 10485760, // 10MB for large segments
      allowAutoTopicCreation: false, // Faster startup
      maxWaitTimeInMs: 100, // Minimal wait time for immediate processing
      retry: {
        initialRetryTime: 50,
        retries: 3,
      },
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: topicName,
      fromBeginning: consumerOptions?.fromBeginning || false,
    });

    await consumer.run({
      autoCommit: true,
      autoCommitInterval: 1000, // More frequent commits for immediate processing
      eachMessage: onMessage,
    });

    this.consumers.set(consumerId, consumer);
    this.logger.log(
      `✅ Consumer created for topic ${topicName} with group ${groupId}`,
    );

    return consumer;
  }

  /**
   * Send segment computation job
   */
  async sendSegmentComputationJob(job: any): Promise<void> {
    await this.sendToTopic(
      SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_JOBS.name,
      job,
      job.segmentId,
      {
        'job-type': 'computation',
        'segment-id': job.segmentId,
        priority: job.priority,
      },
    );
  }

  /**
   * Send high priority segment computation job
   */
  async sendPrioritySegmentComputationJob(job: any): Promise<void> {
    await this.sendToTopic(
      SEGMENT_KAFKA_TOPICS.SEGMENT_COMPUTATION_PRIORITY.name,
      job,
      job.segmentId,
      {
        'job-type': 'computation-priority',
        'segment-id': job.segmentId,
        priority: job.priority,
      },
    );
  }

  /**
   * Send segment computation result
   */
  async sendSegmentResult(result: any): Promise<void> {
    await this.sendToTopic(
      SEGMENT_KAFKA_TOPICS.SEGMENT_RESULTS.name,
      result,
      result.jobId,
      {
        'result-type': 'computation-result',
        'job-id': result.jobId,
        'segment-id': result.segmentId,
        status: result.status,
      },
    );
  }

  /**
   * Send status update
   */
  async sendStatusUpdate(status: any): Promise<void> {
    await this.sendToTopic(
      SEGMENT_KAFKA_TOPICS.SEGMENT_STATUS.name,
      status,
      status.workerId || status.consumerId,
      {
        'status-type': status.type,
        timestamp: new Date().toISOString(),
      },
    );
  }

  /**
   * Send to dead letter queue
   */
  async sendToDeadLetterQueue(
    originalMessage: any,
    error: Error,
  ): Promise<void> {
    await this.sendToTopic(
      SEGMENT_KAFKA_TOPICS.SEGMENT_DLQ.name,
      {
        originalMessage,
        error: {
          message: error.message,
          stack: error.stack,
          timestamp: Date.now(),
        },
        dlqTimestamp: Date.now(),
      },
      originalMessage.jobId || originalMessage.id,
      {
        'dlq-reason': 'processing-failed',
        'original-topic': originalMessage.topic || 'unknown',
        'error-type': error.constructor.name,
      },
    );
  }

  /**
   * Get service status
   */
  async getStatus() {
    return {
      connected: !!this.producer,
      topics: Object.entries(SEGMENT_KAFKA_TOPICS).map(([key, config]) => ({
        key,
        name: config.name,
        partitions: config.partitions,
      })),
      consumers: Array.from(this.consumers.keys()),
      brokers: this.config.kafka?.brokers || ['localhost:9092'],
    };
  }

  /**
   * Health check for distributed processing
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.admin) {
        return false;
      }

      // Check if we can list topics
      const topics = await this.admin.listTopics();

      // Check if our required topics exist
      const requiredTopics = Object.values(SEGMENT_KAFKA_TOPICS).map(
        (t) => t.name,
      );
      const missingTopics = requiredTopics.filter(
        (topic) => !topics.includes(topic),
      );

      if (missingTopics.length > 0) {
        this.logger.warn(
          `Missing required topics: ${missingTopics.join(', ')}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Distributed Kafka health check failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Disconnect all clients
   */
  async disconnect() {
    try {
      // Disconnect all consumers
      for (const [id, consumer] of this.consumers.entries()) {
        await consumer.disconnect();
        this.logger.log(`Consumer ${id} disconnected`);
      }
      this.consumers.clear();

      if (this.producer) {
        await this.producer.disconnect();
        this.logger.log('Distributed Kafka producer disconnected');
      }

      if (this.admin) {
        await this.admin.disconnect();
        this.logger.log('Distributed Kafka admin disconnected');
      }
    } catch (error) {
      this.logger.error(
        `Error disconnecting distributed Kafka: ${error.message}`,
      );
    }
  }
}
