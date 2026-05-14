import { EventData, ProcessingResult } from './event-data.interface';

export interface QueueProcessor {
  /**
   * Processa o evento - pode ser direto ou através de fila
   */
  processEvent(eventData: EventData): Promise<ProcessingResult>;

  /**
   * Configurações específicas do processador
   */
  getConfig(): Record<string, any>;

  /**
   * Health check do processador
   */
  healthCheck(): Promise<boolean>;
}
