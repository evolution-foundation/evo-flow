import { ConfigService } from '@nestjs/config';

/**
 * Header that carries how many times a message has been redelivered. Absent on
 * first delivery (treated as 0); incremented on every `nack(requeue=true)`.
 */
export const DELIVERY_ATTEMPT_HEADER = 'x-delivery-attempt';
export const DLQ_REASON_HEADER = 'x-dlq-reason';
export const ORIGINAL_TOPIC_HEADER = 'x-original-topic';
export const DELIVERY_LIMIT_EXCEEDED = 'delivery-limit-exceeded';

const DEFAULT_DELIVERY_LIMIT = 3;

/** DLQ/DLT name for a topic or queue: `<name>.dlq`. */
export function dlqNameFor(name: string): string {
  return `${name}.dlq`;
}

/** The attempt number a redelivery would carry (current + 1, missing = 0). */
export function nextAttempt(headers: Record<string, string>): number {
  const raw = headers[DELIVERY_ATTEMPT_HEADER];
  const current = raw === undefined ? 0 : parseInt(raw, 10);
  const safe = Number.isFinite(current) && current >= 0 ? current : 0;
  return safe + 1;
}

/**
 * Redelivery ceiling (env `BROKER_DELIVERY_LIMIT`, default 3). A message that
 * reaches this many redeliveries is dead-lettered instead of requeued, so a
 * poison message can never block a queue/partition indefinitely (EVO-1677).
 */
export function resolveDeliveryLimit(config: ConfigService): number {
  const raw = config.get<string>('BROKER_DELIVERY_LIMIT');
  if (raw === undefined || raw === '') return DEFAULT_DELIVERY_LIMIT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(
      `BROKER_DELIVERY_LIMIT="${raw}" must be a positive integer.`,
    );
  }
  return parsed;
}
