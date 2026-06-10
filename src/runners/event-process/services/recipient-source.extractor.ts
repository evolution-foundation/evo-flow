import { Injectable } from '@nestjs/common';
import { Platform } from '../../../shared/broker/contracts';

export interface RecipientSource {
  userAgent?: string;
  ip?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Extracts the END-RECIPIENT's user-agent and IP from a provider webhook body
 * (story 3.6 / EVO-1212). For email engagement events (open/click) the real
 * recipient UA/IP live in the payload — the HTTP envelope only carries the
 * provider's own server UA/IP. Returns `{}` for providers/payloads that don't
 * carry it, so the caller can fall back to the envelope.
 *
 * Array payloads (SendGrid/Mandrill batch one POST as many events): the MVP
 * reads the first event; per-event fan-out is a downstream normalization
 * concern. `mailersend` reuses the engagement heuristic as a best-effort.
 */
@Injectable()
export class RecipientSourceExtractor {
  extract(platform: Platform, payload: unknown): RecipientSource {
    const event: unknown = Array.isArray(payload)
      ? (payload as unknown[])[0]
      : payload;
    if (!isRecord(event)) return {};

    switch (platform) {
      case 'sendgrid':
        return { userAgent: asString(event.useragent), ip: asString(event.ip) };
      case 'mandrill':
        return {
          userAgent: asString(event.user_agent),
          ip: asString(event.ip),
        };
      case 'resend':
      case 'mailersend':
        return this.fromEngagement(event.data);
      case 'ses':
        return this.fromSes(event);
      case 'sparkpost':
        return this.fromSparkpost(event);
      default:
        return {};
    }
  }

  // Resend / MailerSend: { data: { open | click: { userAgent, ipAddress } } }
  private fromEngagement(data: unknown): RecipientSource {
    if (!isRecord(data)) return {};
    const engagement =
      (isRecord(data.open) && data.open) ||
      (isRecord(data.click) && data.click);
    if (!isRecord(engagement)) return {};
    return {
      userAgent:
        asString(engagement.userAgent) ?? asString(engagement.user_agent),
      ip: asString(engagement.ipAddress) ?? asString(engagement.ip),
    };
  }

  // SES via SNS: { Message: '<json>' } whose body is { open | click: { userAgent, ipAddress } }
  private fromSes(event: Record<string, unknown>): RecipientSource {
    const message = this.parseMaybeJson(event.Message) ?? event;
    if (!isRecord(message)) return {};
    const engagement =
      (isRecord(message.open) && message.open) ||
      (isRecord(message.click) && message.click);
    if (!isRecord(engagement)) return {};
    return {
      userAgent: asString(engagement.userAgent),
      ip: asString(engagement.ipAddress),
    };
  }

  // SparkPost: { msys: { track_event | message_event: { user_agent, ip_address } } }
  private fromSparkpost(event: Record<string, unknown>): RecipientSource {
    if (!isRecord(event.msys)) return {};
    const trackEvent =
      (isRecord(event.msys.track_event) && event.msys.track_event) ||
      (isRecord(event.msys.message_event) && event.msys.message_event);
    if (!isRecord(trackEvent)) return {};
    return {
      userAgent: asString(trackEvent.user_agent),
      ip: asString(trackEvent.ip_address),
    };
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
}
