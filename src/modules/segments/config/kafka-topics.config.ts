export interface KafkaTopicConfig {
  name: string;
  partitions: number;
  replicationFactor: number;
  config?: Record<string, string>;
}

/**
 * Kafka Topics Configuration for Distributed Segment Processing
 */
export const SEGMENT_KAFKA_TOPICS: Record<string, KafkaTopicConfig> = {
  // Main job queue for segment computation requests
  SEGMENT_COMPUTATION_JOBS: {
    name: 'evo-segment-computation',
    partitions: 12, // Allows for high parallelism
    replicationFactor: 3,
    config: {
      'retention.ms': '86400000', // 24 hours
      'cleanup.policy': 'delete',
      'compression.type': 'uncompressed',
    },
  },

  // Results queue for completed computations
  SEGMENT_COMPUTATION_RESULTS: {
    name: 'evo-segment-results',
    partitions: 6, // Lower than jobs since results are smaller
    replicationFactor: 3,
    config: {
      'retention.ms': '604800000', // 7 days for debugging
      'cleanup.policy': 'delete',
      'compression.type': 'uncompressed',
    },
  },

  // Status updates and monitoring
  SEGMENT_STATUS_UPDATES: {
    name: 'evo-segment-status',
    partitions: 3,
    replicationFactor: 3,
    config: {
      'retention.ms': '259200000', // 3 days
      'cleanup.policy': 'delete',
      'compression.type': 'uncompressed',
    },
  },

  // Dead letter queue for failed jobs
  SEGMENT_COMPUTATION_DLQ: {
    name: 'evo-segment-computation-dlq',
    partitions: 3,
    replicationFactor: 3,
    config: {
      'retention.ms': '2592000000', // 30 days for investigation
      'cleanup.policy': 'delete',
      'compression.type': 'uncompressed',
    },
  },

  // High priority jobs (real-time segments)
  SEGMENT_COMPUTATION_PRIORITY: {
    name: 'evo-segment-computation-priority',
    partitions: 6,
    replicationFactor: 3,
    config: {
      'retention.ms': '43200000', // 12 hours
      'cleanup.policy': 'delete',
      'compression.type': 'uncompressed',
    },
  },
};

/**
 * Consumer Group IDs for different types of workers
 */
export const SEGMENT_CONSUMER_GROUPS = {
  COMPUTATION_WORKERS: 'evo-segment-computation-workers',
  RESULT_PROCESSORS: 'evo-segment-result-processors',
  STATUS_MONITORS: 'evo-segment-status-monitors',
  PRIORITY_WORKERS: 'evo-segment-priority-workers',
} as const;

/**
 * Job Priority Levels
 */
export enum SegmentJobPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

/**
 * Job Status Types
 */
export enum SegmentJobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRY = 'retry',
  DEAD_LETTER = 'dead_letter',
}

/**
 * Kafka Configuration for Segment Processing
 */
export interface SegmentKafkaConfig {
  brokers: string[];
  groupId: string;
  clientId: string;

  // Consumer settings
  consumer: {
    sessionTimeout: number;
    heartbeatInterval: number;
    maxWaitTime: number;
    minBytes: number;
    maxBytes: number;
    partitionsConsumedConcurrently: number;
  };

  // Producer settings
  producer: {
    maxInFlightRequests: number;
    idempotent: boolean;
    transactionTimeout: number;
    acks: number;
    compression: string;
    batchSize: number;
    linger: number;
  };
}

/**
 * Default Kafka configuration optimized for segment processing
 */
export function getSegmentKafkaConfig(): SegmentKafkaConfig {
  return {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    groupId:
      process.env.SEGMENT_KAFKA_GROUP_ID ||
      SEGMENT_CONSUMER_GROUPS.COMPUTATION_WORKERS,
    clientId: `evo-segment-worker-${process.env.HOSTNAME || 'localhost'}`,

    consumer: {
      // Kafka broker requires sessionTimeout >= 6000ms and <= 300000ms
      sessionTimeout: parseInt(process.env.KAFKA_SESSION_TIMEOUT || '30000'), // 30s - within broker limits
      // heartbeatInterval must be <= sessionTimeout / 3
      heartbeatInterval: parseInt(
        process.env.KAFKA_HEARTBEAT_INTERVAL || '3000',
      ), // 3s - must be <= sessionTimeout / 3
      maxWaitTime: parseInt(process.env.KAFKA_MAX_WAIT_TIME || '100'), // Minimal wait time for immediate processing
      minBytes: parseInt(process.env.KAFKA_MIN_BYTES || '1'),
      maxBytes: parseInt(process.env.KAFKA_MAX_BYTES || '10485760'), // 10MB
      partitionsConsumedConcurrently: parseInt(
        process.env.KAFKA_CONCURRENT_PARTITIONS || '10',
      ), // More concurrent processing
    },

    producer: {
      maxInFlightRequests: parseInt(process.env.KAFKA_MAX_IN_FLIGHT || '5'),
      idempotent: true,
      transactionTimeout: parseInt(
        process.env.KAFKA_TRANSACTION_TIMEOUT || '30000',
      ),
      acks: parseInt(process.env.KAFKA_ACKS || '1'), // 1 = leader ack, -1 = all replicas
      compression: process.env.KAFKA_COMPRESSION || 'none',
      batchSize: parseInt(process.env.KAFKA_BATCH_SIZE || '16384'), // 16KB
      linger: parseInt(process.env.KAFKA_LINGER_MS || '10'), // 10ms batching
    },
  };
}
