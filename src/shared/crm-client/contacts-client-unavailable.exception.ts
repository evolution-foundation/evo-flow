import { ServiceUnavailableException } from '@nestjs/common';

export interface ContactsClientUnavailableDetails {
  /**
   * Correlation id read from the request context (Story 2.5). Undefined when
   * the failure happens outside an active request scope.
   */
  correlationId?: string;
  /** Endpoint that exhausted retries, formatted as `METHOD /path`. */
  endpoint: string;
  /** Last HTTP status observed before giving up (undefined for network/timeout/circuit-open). */
  lastStatusCode?: number;
  /** Total wall-clock latency across all attempts + backoff, in ms. */
  totalLatencyMs: number;
  /** Coarse failure classification for logs/metrics. */
  reason:
    | 'server_error'
    | 'network'
    | 'timeout'
    | 'rate_limited'
    | 'circuit_open';
}

/**
 * Thrown by the hardened generic CRM client path when a request to
 * evo-ai-crm-community is still failing after the retry budget is exhausted
 * (or the circuit breaker is open). Extends `ServiceUnavailableException` so it
 * keeps 503 semantics and remains catchable by callers that already handle
 * `ServiceUnavailableException`.
 *
 * Fallback contract: the campaign-packer (Epic 4) must catch this and mark the
 * campaign as `Failed`, recording `correlationId` + `endpoint` for triage.
 * See `src/shared/crm-client/README.md`.
 */
export class ContactsClientUnavailableException extends ServiceUnavailableException {
  readonly correlationId?: string;
  readonly endpoint: string;
  readonly lastStatusCode?: number;
  readonly totalLatencyMs: number;
  readonly reason: ContactsClientUnavailableDetails['reason'];

  constructor(details: ContactsClientUnavailableDetails) {
    super({
      error: 'ContactsClientUnavailable',
      message: `CRM contacts client unavailable after retries: ${details.endpoint}`,
      correlationId: details.correlationId,
      endpoint: details.endpoint,
      lastStatusCode: details.lastStatusCode,
      totalLatencyMs: details.totalLatencyMs,
      reason: details.reason,
    });
    this.correlationId = details.correlationId;
    this.endpoint = details.endpoint;
    this.lastStatusCode = details.lastStatusCode;
    this.totalLatencyMs = details.totalLatencyMs;
    this.reason = details.reason;
  }
}
