import { QueueProcessor } from '../interfaces/queue-processor.interface';
import {
  EventData,
  ProcessingResult,
} from '../interfaces/event-data.interface';
import { StorageProcessor } from '../interfaces/storage-processor.interface';
import { StorageProcessorFactory } from '../factories/storage-processor.factory';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * DirectQueueProcessor — grava o evento direto no storage (ClickHouse) na mesma
 * requisição, sem broker/fila no meio. É a contraparte síncrona dos consumers
 * de fila: faz o mesmo `storageProcessor.saveEvent(eventData)` que eles fazem
 * após o dequeue, só que inline.
 *
 * Uso: QUEUE_MODE=direct (+ WRITE_MODE=ch-sync) para single-node / dev / debug,
 * eliminando a necessidade de um worker/consumer separado. O enum QueueMode.DIRECT
 * já existia ("Processa imediatamente sem fila") mas não era tratado na factory.
 */
export class DirectQueueProcessor implements QueueProcessor {
  private readonly logger = new CustomLoggerService(DirectQueueProcessor.name);
  private readonly storageProcessor: StorageProcessor;

  constructor(clickhouseService: ClickHouseService) {
    // Mesmo storage processor usado pelos consumers (Redis/RabbitMQ/Kafka).
    // Segment services são opcionais; sem eles o evento é persistido sem o
    // recompute de segmento em tempo real (que continua disponível via worker).
    this.storageProcessor = StorageProcessorFactory.create(clickhouseService);
  }

  async processEvent(eventData: EventData): Promise<ProcessingResult> {
    this.logger.debug(
      `Writing event directly to storage: ${eventData.eventType}`,
    );

    try {
      await this.storageProcessor.saveEvent(eventData);

      this.logger.log(
        `Event written directly to storage: ${eventData.messageId}`,
      );

      return {
        messageId: eventData.messageId,
        status: 'success',
      };
    } catch (error) {
      this.logger.error(
        `Failed to write event directly: ${error.message}`,
        error.stack,
      );

      return {
        messageId: eventData.messageId,
        status: 'error',
        error: `Direct write error: ${error.message}`,
      };
    }
  }

  getConfig(): Record<string, any> {
    return {
      mode: 'direct',
      description:
        'Writes events directly to storage synchronously (no queue/broker)',
    };
  }

  async healthCheck(): Promise<boolean> {
    // Sem broker para checar; a saúde efetiva é a do ClickHouse, validada no
    // próprio saveEvent. Retorna true para não falhar a init do processor.
    return true;
  }
}
