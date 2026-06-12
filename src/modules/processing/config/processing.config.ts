// 🔧 CRITICAL: Load .env BEFORE reading any process.env variables
import * as dotenv from 'dotenv';
dotenv.config();

import { QueueMode, RunMode } from '../enums';
import { WriteMode } from '../enums/write-mode.enum';

export interface ProcessingConfig {
  runMode: RunMode;
  queueMode: QueueMode;
  writeMode: WriteMode;

  // Configurações Redis
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    queueName: string;
  };

  // Configurações RabbitMQ
  rabbitmq?: {
    url: string;
    exchange: string;
    queue: string;
    routingKey: string;
  };

  // Configurações Kafka
  kafka?: {
    brokers: string[];
    brokersInternal?: string; // DNS usado pelo ClickHouse Kafka Engine
    topic: string;
    groupId: string;
    partitions?: number;
    replicationFactor?: number;
    topicConfig?: {
      retentionMs: string;
      retentionBytes: string;
      compressionType: string;
      maxMessageBytes: string;
    };
  };

  // Configurações ClickHouse
  clickhouse?: {
    host: string;
    port: number;
    protocol?: string; // http ou https
    database: string;
    username?: string;
    password?: string;
    table: string;
    maxConnections?: number;
    minConnections?: number;
    acquireTimeoutMs?: number;
    idleTimeoutMs?: number;
  };

  // Configurações gerais
  maxRetries: number;
  retryDelay: number;
  batchSize: number;
  workerConcurrency: number;

  // Configurações específicas para segment computation
  segmentComputation?: {
    batchSize: number;
    maxConcurrency: number;
    timeoutMs: number;
    circuitBreakerEnabled: boolean;
    metricsEnabled: boolean;
  };

  // Configurações Temporal
  temporal?: {
    serverAddress: string;
    namespace?: string;
    taskQueue?: string;
    workflowTimeoutMs?: number;
  };
}

export function parseRunMode(raw: string | undefined): RunMode {
  if (raw === undefined) return RunMode.SINGLE;
  if (raw === '') {
    throw new Error(
      'RUN_MODE is set to an empty string. Unset the variable to use the default (single) or set a valid value.',
    );
  }
  const valid: readonly string[] = Object.values(RunMode);
  if (!valid.includes(raw)) {
    throw new Error(
      `Invalid RUN_MODE='${raw}'. Valid values: ${valid.join(', ')}.`,
    );
  }
  return raw as RunMode;
}

export function getProcessingConfig(): ProcessingConfig {
  const runMode = parseRunMode(process.env.RUN_MODE);
  const queueMode = (process.env.QUEUE_MODE as QueueMode) || QueueMode.KAFKA;
  const writeMode = (process.env.WRITE_MODE as WriteMode) || WriteMode.KAFKA;

  return {
    runMode,
    queueMode,
    writeMode,

    // Redis config
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '5'),
      queueName: process.env.REDIS_QUEUE_NAME || 'evo-campaign-events',
    },

    // RabbitMQ config
    rabbitmq: {
      url: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
      exchange: process.env.RABBITMQ_EXCHANGE || 'evo-campaign-events',
      queue: process.env.RABBITMQ_QUEUE || 'events-queue',
      routingKey: process.env.RABBITMQ_ROUTING_KEY || 'event',
    },

    // Kafka config
    kafka: {
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      brokersInternal:
        process.env.KAFKA_BROKERS_INTERNAL ||
        process.env.KAFKA_BROKERS ||
        'localhost:9092',
      topic: process.env.KAFKA_TOPIC || 'evo-campaign-events',
      groupId: process.env.KAFKA_GROUP_ID || 'evo-campaign-consumers',
      partitions: parseInt(process.env.KAFKA_PARTITIONS || '1'),
      replicationFactor: parseInt(
        process.env.KAFKA_TOPIC_REPLICATION_FACTOR || '1',
      ),
      topicConfig: {
        retentionMs: process.env.KAFKA_TOPIC_RETENTION_MS || '86400000',
        retentionBytes:
          process.env.KAFKA_TOPIC_RETENTION_BYTES || '64424509440',
        // kafkajs (^2.2.4) only decodes gzip natively; zstd/snappy need a
        // registered codec (zstd's is a native build that doesn't ship here),
        // so a zstd topic crashes the kafkajs consumers on fetch (EVO-1727).
        compressionType: process.env.KAFKA_TOPIC_COMPRESSION_TYPE || 'gzip',
        maxMessageBytes:
          process.env.KAFKA_TOPIC_MAX_MESSAGE_BYTES || '10485760',
      },
    },

    // ClickHouse config (optimized for segment computation load)
    clickhouse: {
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      protocol: process.env.CLICKHOUSE_PROTOCOL || 'http',
      database: process.env.CLICKHOUSE_DATABASE || 'evo_campaign',
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD,
      table: process.env.CLICKHOUSE_TABLE || 'contact_events',
      maxConnections: parseInt(process.env.CLICKHOUSE_MAX_CONNECTIONS || '100'),
      minConnections: parseInt(process.env.CLICKHOUSE_MIN_CONNECTIONS || '20'),
      acquireTimeoutMs: parseInt(
        process.env.CLICKHOUSE_ACQUIRE_TIMEOUT || '45000',
      ),
      idleTimeoutMs: parseInt(process.env.CLICKHOUSE_IDLE_TIMEOUT || '180000'),
    },

    // General config
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000'),
    batchSize: parseInt(process.env.BATCH_SIZE || '100'),
    workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),

    // Segment computation optimized config
    segmentComputation: {
      batchSize: parseInt(process.env.SEGMENT_BATCH_SIZE || '50'),
      maxConcurrency: parseInt(process.env.SEGMENT_MAX_CONCURRENCY || '20'),
      timeoutMs: parseInt(process.env.SEGMENT_TIMEOUT || '45000'),
      circuitBreakerEnabled:
        process.env.SEGMENT_CIRCUIT_BREAKER_ENABLED !== 'false',
      metricsEnabled: process.env.SEGMENT_METRICS_ENABLED !== 'false',
    },

    // Temporal configuration
    temporal: {
      serverAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'journey-execution',
      workflowTimeoutMs: parseInt(
        process.env.TEMPORAL_WORKFLOW_TIMEOUT || '300000',
      ), // 5 minutes
    },
  };
}
