import { z } from 'zod';

export const EVENTS_FAILED_TOPIC = 'events.failed';

/**
 * `failureReason` is a free-form string at the contract layer with the
 * convention `<system>_<action>_<outcome>` (e.g. `clickhouse_insert_exhausted_retries`,
 * see story 3.8). A closed enum would couple the contract to every possible
 * failure point in the pipeline; we keep it loose and rely on naming
 * convention + metrics labels for grouping.
 */
export const eventsFailedSchema = z
  .object({
    originalTopic: z.string().min(1),
    originalPayload: z.unknown(),
    failureReason: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    lastFailureAt: z.iso.datetime({ offset: true }),
    correlationId: z.uuidv4(),
  })
  .strict();

export type EventsFailedContract = z.infer<typeof eventsFailedSchema>;

export function isEventsFailedContract(
  payload: unknown,
): payload is EventsFailedContract {
  return eventsFailedSchema.safeParse(payload).success;
}
