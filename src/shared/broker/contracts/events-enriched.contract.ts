import { z } from 'zod';
import { eventsReceivedSchema } from './events-received.contract';

/**
 * NOTE: stories 3.6 (EnricherService) and 3.7 (ClickHouseWriter) consume
 * `EventsEnrichedContract` in-process via direct method call today, not via
 * a broker publish/subscribe. The card lists it among the 7 broker topics,
 * so the contract is shipped here for both uses; promoting it to a real
 * broker hop is a downstream decision.
 */
export const EVENTS_ENRICHED_TOPIC = 'events.enriched';

const userAgentSchema = z.object({
  browser: z.object({
    name: z.string(),
    version: z.string(),
  }),
  os: z.object({
    name: z.string(),
    version: z.string(),
  }),
  device: z.object({
    type: z.string(),
    vendor: z.string(),
    model: z.string(),
  }),
});

const geoSchema = z.object({
  country: z.string(),
  region: z.string(),
  city: z.string(),
});

const botMarkersSchema = z.object({
  isBot: z.boolean(),
  isDatacenter: z.boolean(),
});

export const eventsEnrichedSchema = eventsReceivedSchema.extend({
  ua: userAgentSchema,
  geo: geoSchema,
  botMarkers: botMarkersSchema,
});

export type EventsEnrichedContract = z.infer<typeof eventsEnrichedSchema>;

export function isEventsEnrichedContract(
  payload: unknown,
): payload is EventsEnrichedContract {
  return eventsEnrichedSchema.safeParse(payload).success;
}
