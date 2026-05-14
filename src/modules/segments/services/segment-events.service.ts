import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { ProcessingService } from '../../processing/processing.service';
import { EventData } from '../../processing/interfaces/event-data.interface';
import { EventType } from '../../../common/enums/event-type.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentChange {
  contactId: string;
  segmentId: string;
  segmentName: string;
  previousValue: boolean;
  newValue: boolean;
  timestamp: Date;
}

@Injectable()
export class SegmentEventsService {
  private readonly logger = new CustomLoggerService(SegmentEventsService.name);

  constructor(
    @Inject(forwardRef(() => ProcessingService))
    private readonly processingService: ProcessingService,
  ) {}

  /**
   * Processa mudanças de segmento e gera eventos correspondentes
   */
  async processSegmentChanges(
    segmentId: string,
    segmentName: string,
    changes: Array<{
      contactId: string;
      previousValue: boolean;
      newValue: boolean;
    }>,
  ): Promise<void> {
    this.logger.debug(
      `Processing ${changes.length} segment changes for segment ${segmentName} (${segmentId})`,
    );

    // Processar cada mudança individualmente
    for (const change of changes) {
      try {
        await this.createSegmentEvent({
          contactId: change.contactId,
          segmentId,
          segmentName,
          previousValue: change.previousValue,
          newValue: change.newValue,
          timestamp: new Date(),
        });
      } catch (error) {
        this.logger.error(
          `Failed to create segment event for contact ${change.contactId}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Processa mudanças de segmento de forma assíncrona (fire-and-forget)
   * Para não travar a computação principal do segmento
   */
  processSegmentChangesAsync(
    segmentId: string,
    segmentName: string,
    changes: Array<{
      contactId: string;
      previousValue: boolean;
      newValue: boolean;
    }>,
  ): void {
    this.logger.debug(
      `Queuing ${changes.length} segment changes for async processing for segment ${segmentName} (${segmentId})`,
    );

    // Processar de forma assíncrona sem await - fire and forget
    setImmediate(async () => {
      try {
        await this.processSegmentChanges(segmentId, segmentName, changes);
        this.logger.debug(
          `Completed async processing of ${changes.length} segment changes for segment ${segmentName}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to process segment changes asynchronously for segment ${segmentName}: ${error.message}`,
        );
      }
    });
  }

  /**
   * Cria evento de mudança de segmento
   */
  private async createSegmentEvent(change: SegmentChange): Promise<void> {
    const eventName = this.determineEventName(
      change.previousValue,
      change.newValue,
    );

    if (!eventName) {
      // Não houve mudança real
      return;
    }

    const eventData: EventData = {
      messageId: `segment-change-${change.segmentId}-${change.contactId}-${Date.now()}`,
      contactId: change.contactId,
      eventType: EventType.SEGMENT,
      eventName,
      properties: {
        segmentId: change.segmentId,
        segmentName: change.segmentName,
        previousValue: change.previousValue,
        newValue: change.newValue,
        changeType: this.getChangeType(change.previousValue, change.newValue),
        timestamp: change.timestamp.toISOString(),
      },
      traits: {
        // Traits vazios para eventos de segmento - o foco está nas properties
      },
      timestamp: change.timestamp.toISOString(),
    };

    await this.processingService.processEvent(eventData);

    this.logger.debug(
      `Created ${eventName} event for contact ${change.contactId} in segment ${change.segmentName}`,
    );
  }

  /**
   * Determina o nome do evento baseado na mudança
   */
  private determineEventName(
    previousValue: boolean,
    newValue: boolean,
  ): string | null {
    if (previousValue === false && newValue === true) {
      return 'segment_entered';
    } else if (previousValue === true && newValue === false) {
      return 'segment_exited';
    }

    // Sem mudança
    return null;
  }

  /**
   * Determina o tipo de mudança
   */
  private getChangeType(previousValue: boolean, newValue: boolean): string {
    if (previousValue === false && newValue === true) {
      return 'entered';
    } else if (previousValue === true && newValue === false) {
      return 'exited';
    }

    return 'no_change';
  }

  /**
   * Detecta mudanças comparando estados antigos e novos de segmento
   */
  async detectSegmentChanges(
    segmentId: string,
  ): Promise<
    Array<{
      contactId: string;
      previousValue: boolean;
      newValue: boolean;
    }>
  > {
    // Esta função seria implementada para comparar o estado anterior
    // com o novo estado dos assignments do segmento no ClickHouse
    // Por simplicidade, vamos deixar isso para ser implementado quando
    // tivermos acesso aos dados de comparação

    this.logger.debug(
      `Detecting segment changes for segment ${segmentId} (placeholder implementation)`,
    );

    return [];
  }
}
