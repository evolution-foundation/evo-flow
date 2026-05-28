import { z } from 'zod';

/**
 * `events.enriched` carries the **post-normalization** event produced by
 * the event-process pipeline (story 3.6) — not the receiver envelope plus
 * enrichment fields. The producer resolves `contactId`, canonicalizes
 * `eventType`, extracts provider-specific data into `properties`, and
 * derives `enrichment` (ua/geo/botMarkers) before publishing.
 *
 * Publication on the broker is **optional** in the MVP per PRD §Topic
 * Contracts (FR18 — "pode opcionalmente publicar"). Today the event-process
 * pipeline consumes the same shape in-process for the ClickHouse insert
 * path (story 3.7) and only emits to the broker for downstream BI/analytics
 * consumers when configured. `EVENTS_ENRICHED_TOPIC` is intentionally
 * absent from `BROKER_PUBLISH_TOPICS` in `broker-topics.ts` — it lives in
 * `ALL_CONTRACT_TOPIC_NAMES` only.
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

const enrichmentSchema = z
  .object({
    ua: userAgentSchema,
    geo: geoSchema,
    botMarkers: botMarkersSchema,
  })
  .strict();

export const eventsEnrichedSchema = z
  .object({
    contactId: z.string().min(1),
    eventType: z.string().min(1),
    properties: z.record(z.string(), z.unknown()),
    enrichment: enrichmentSchema,
    correlationId: z.uuidv4(),
  })
  .strict();

export type EventsEnrichedContract = z.infer<typeof eventsEnrichedSchema>;

export function isEventsEnrichedContract(
  payload: unknown,
): payload is EventsEnrichedContract {
  return eventsEnrichedSchema.safeParse(payload).success;
}
