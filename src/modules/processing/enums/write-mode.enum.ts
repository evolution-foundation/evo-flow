export enum WriteMode {
  KAFKA = 'kafka', // Write to Kafka, then batch to ClickHouse
  CH_ASYNC = 'ch-async', // Direct async write to ClickHouse
  CH_SYNC = 'ch-sync', // Direct sync write to ClickHouse (for testing)
  REDIS = 'redis', // Write to Redis queue (our current implementation)
  RABBITMQ = 'rabbitmq', // Write to RabbitMQ queue
}
