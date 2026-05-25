import type { EvoFlowEventName } from '../event-names.enum';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'uuid' | 'object';

export interface FieldSpec {
  type: FieldType;
  description?: string;
}

export interface EventSchema {
  required: Record<string, FieldSpec>;
  optional: Record<string, FieldSpec>;
  allowExtraProperties: boolean;
}

export type EventCategory = 'contact' | 'conversation' | 'message' | 'campaign' | 'custom';

export interface EventCatalogEntry {
  eventName: EvoFlowEventName | 'custom';
  category: EventCategory;
  labelPt: string;
  labelEn: string;
  description: string;
  schema: EventSchema;
}

export type EventCatalog = Record<EvoFlowEventName | 'custom', EventCatalogEntry>;
