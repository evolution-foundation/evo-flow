import { EVENT_NAMES, type EvoFlowEventName } from '../event-names.enum';
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  assertCatalogCoversAllNames,
} from './event-catalog';
import type {
  EventCatalogEntry,
  EventCategory,
  EventSchema,
} from './event-schema.types';

assertCatalogCoversAllNames();

export type { EventCatalogEntry, EventCategory, EventSchema, FieldSpec, FieldType } from './event-schema.types';
export { EVENT_CATEGORIES };

export function getEventCatalog(): EventCatalogEntry[] {
  return EVENT_NAMES.map((name) => EVENT_CATALOG[name]);
}

export function getEvent(eventName: string): EventCatalogEntry | undefined {
  return (EVENT_CATALOG as Record<string, EventCatalogEntry>)[eventName];
}

export function isCanonicalEvent(eventName: string): eventName is EvoFlowEventName {
  return (EVENT_NAMES as readonly string[]).includes(eventName);
}

export function getEventsByCategory(category: EventCategory): EventCatalogEntry[] {
  return getEventCatalog().filter((entry) => entry.category === category);
}
