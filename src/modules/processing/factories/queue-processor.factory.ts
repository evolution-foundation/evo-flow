import { Injectable } from '@nestjs/common';
import { QueueMode } from '../enums/queue-mode.enum';
import { QueueProcessor } from '../interfaces/queue-processor.interface';
import { RedisQueueProcessor } from '../queue-processors/redis.processor';
import { KafkaQueueProcessor } from '../queue-processors/kafka.processor';
import { RabbitMQQueueProcessor } from '../queue-processors/rabbitmq.processor';
import { DirectQueueProcessor } from '../queue-processors/direct.processor';
import { getProcessingConfig } from '../config/processing.config';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { KafkaService } from '../kafka/kafka.service';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class QueueProcessorFactory {
  private static readonly logger = new CustomLoggerService(
    QueueProcessorFactory.name,
  );

  static create(
    clickhouseService?: ClickHouseService,
    kafkaService?: KafkaService,
    rabbitMQService?: RabbitMQService,
  ): QueueProcessor {
    const config = getProcessingConfig();

    this.logger.log(`Creating queue processor for mode: ${config.queueMode}`);

    switch (config.queueMode) {
      case QueueMode.DIRECT:
        // Grava direto no ClickHouse, sem fila/broker (single-node / dev /
        // debug). Casa com WRITE_MODE=ch-sync. Sem ClickHouse não há para onde
        // gravar — falha explícita em vez de cair no broker errado.
        if (!clickhouseService) {
          throw new Error(
            'ClickHouse service not provided for direct queue mode',
          );
        }
        return new DirectQueueProcessor(clickhouseService);

      case QueueMode.REDIS:
        return new RedisQueueProcessor();

      case QueueMode.KAFKA:
        if (!kafkaService) {
          this.logger.warn(
            'Kafka service not provided, falling back to direct',
          );
          throw new Error('Kafka service not provided');
        }
        return new KafkaQueueProcessor(kafkaService);

      case QueueMode.RABBITMQ:
        if (!rabbitMQService) {
          this.logger.warn(
            'RabbitMQ service not provided, falling back to direct',
          );
          throw new Error('RabbitMQ service not provided');
        }
        return new RabbitMQQueueProcessor(rabbitMQService);

      default:
        this.logger.warn(
          `Unknown queue mode: ${config.queueMode}, falling back to direct`,
        );
        throw new Error(`Unknown queue mode: ${config.queueMode}`);
    }
  }

  static getAvailableModes(): QueueMode[] {
    return Object.values(QueueMode);
  }

  static validateMode(mode: string): boolean {
    return Object.values(QueueMode).includes(mode as QueueMode);
  }
}
