export enum QueueMode {
  DIRECT = 'direct', // Processa imediatamente sem fila
  REDIS = 'redis', // Envia para Redis Queue
  RABBITMQ = 'rabbitmq', // Envia para RabbitMQ
  KAFKA = 'kafka', // Envia para Kafka
}
