import { z } from 'zod';
import { eventsReceivedSchema } from './events-received.contract';

/**
 * NOTE: stories 3.6 (EnricherService) and 3.7 (ClickHouseWriter) consume
 * `EventsEnrichedContract` in-process via direct method call today, not via
 * a broker publish/subscribe. The card lists it among the 7 broker topics,
 * so the contract is shipped here for both uses; promoting it to a real
 * broker hop is a downstream decision. Note that `EVENTS_ENRICHED_TOPIC`
 * is intentionally absent from `BROKER_PUBLISH_TOPICS` in `broker-topics.ts`
 * — it lives in `ALL_CONTRACT_TOPIC_NAMES` only.
 */
export const EVENTS_ENRICHED_TOPIC = 'events.enriched';

const userAgentSchema = z
  .object({
    browser: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict(),
    os: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict(),
    device: z
      .object({
        type: z.string(),
        vendor: z.string(),
        model: z.string(),
      })
      .strict(),
  })
  .strict();

const geoSchema = z
  .object({
    country: z.string(),
    region: z.string(),
    city: z.string(),
  })
  .strict();

const botMarkersSchema = z
  .object({
    isBot: z.boolean(),
    isDatacenter: z.boolean(),
  })
  .strict();

export const eventsEnrichedSchema = eventsReceivedSchema
  .extend({
    ua: userAgentSchema,
    geo: geoSchema,
    botMarkers: botMarkersSchema,
  })
  .strict();

export type EventsEnrichedContract = z.infer<typeof eventsEnrichedSchema>;

export function isEventsEnrichedContract(
  payload: unknown,
): payload is EventsEnrichedContract {
  return eventsEnrichedSchema.safeParse(payload).success;
}
