import { z } from 'zod';

/**
 * Whitelist of providers supported by `events.received.<platform>` topic
 * pattern (story 3.2). The `unknown` fallback is published when the
 * webhook URL path does not match a known provider — the event-process
 * consumer drops it silently downstream.
 */
export const PLATFORMS = [
  'evolution-api',
  'sparkpost',
  'sendgrid',
  'mailersend',
  'resend',
  'ses',
  'mandrill',
  'unknown',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

export function isPlatform(value: unknown): value is Platform {
  return platformSchema.safeParse(value).success;
}
