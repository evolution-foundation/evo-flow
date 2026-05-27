import { z } from 'zod';
import { Platform, platformSchema } from './platform.enum';

export const EVENTS_RECEIVED_TOPIC_PREFIX = 'events.received';
export type EventsReceivedTopic =
  `${typeof EVENTS_RECEIVED_TOPIC_PREFIX}.${Platform}`;

export function getEventsReceivedTopic(
  platform: Platform,
): EventsReceivedTopic {
  return `${EVENTS_RECEIVED_TOPIC_PREFIX}.${platform}`;
}

export const eventsReceivedSchema = z
  .object({
    platform: platformSchema,
    rawPayload: z.unknown(),
    headers: z.record(z.string(), z.string()),
    receivedAt: z.iso.datetime({ offset: true }),
    sourceIp: z.string().min(1),
    ingestionId: z.uuidv4(),
    correlationId: z.uuidv4(),
  })
  .strict();

export type EventsReceivedContract = z.infer<typeof eventsReceivedSchema>;

export function isEventsReceivedContract(
  payload: unknown,
): payload is EventsReceivedContract {
  return eventsReceivedSchema.safeParse(payload).success;
}
