import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IncomingHttpHeaders } from 'http';
import {
  EventsReceivedContract,
  Platform,
} from '../../../shared/broker/contracts';
import { readCorrelationIdFromCls } from '../../../shared/correlation/correlation.util';

export interface NormalizerInput {
  platform: Platform;
  rawPayload: unknown;
  headers: IncomingHttpHeaders;
  sourceIp: string;
}

/**
 * Builds the `events.received.<platform>` envelope from a raw inbound webhook
 * (story 3.2 / EVO-1209). Carries the raw payload plus ingestion metadata; it
 * does NOT map provider-specific shapes to a unified schema (that is downstream).
 *
 * `ingestionId` is a fresh UUID v4 per ingestion (distinct from `correlationId`,
 * which chains the request end-to-end) used to trace receiver → broker → process.
 */
@Injectable()
export class PayloadNormalizerService {
  build(input: NormalizerInput): EventsReceivedContract {
    return {
      platform: input.platform,
      rawPayload: input.rawPayload,
      headers: this.flattenHeaders(input.headers),
      receivedAt: new Date().toISOString(),
      sourceIp: input.sourceIp,
      ingestionId: randomUUID(),
      correlationId: readCorrelationIdFromCls() ?? randomUUID(),
    };
  }

  private flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      flat[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return flat;
  }
}
