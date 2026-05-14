import { EventData } from './event-data.interface';

export interface StorageProcessor {
  /**
   * Salva o evento no storage configurado
   */
  saveEvent(eventData: EventData): Promise<void>;

  /**
   * Busca eventos
   */
  getEvents(limit?: number): Promise<any[]>;

  /**
   * Health check do storage
   */
  healthCheck(): Promise<boolean>;

  /**
   * Configurações do storage
   */
  getConfig(): Record<string, any>;
}
