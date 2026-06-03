import { Injectable } from '@nestjs/common';

export interface WebhookIntakePayload {
  platform: string;
  contentType: string;
  rawBody?: Buffer;
  parsed: unknown;
}

/**
 * Ingestion seam for the webhook receiver. Story 3.1 (EVO-1207) ships a dumb
 * pipe: the receiver accepts the payload and returns 200 without publishing.
 *
 * Story 3.2 fills intake() with platform detection, normalization and the
 * IMessageBroker.publish call. A publish failure there throws, which surfaces
 * as the 503 (Retry-After) already wired in WebhooksController — so the error
 * contract is in place before the publish itself exists.
 */
@Injectable()
export class WebhookIntakeService {
  intake(payload: WebhookIntakePayload): Promise<void> {
    // No-op pass-through for story 3.1. Do NOT publish here yet — story 3.2
    // owns the detector + normalizer + broker publish on this seam (which is
    // where the async/await lands).
    void payload;
    return Promise.resolve();
  }
}
