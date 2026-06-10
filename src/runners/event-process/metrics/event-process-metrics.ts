import { Injectable } from '@nestjs/common';
import { Counter, register } from 'prom-client';

const SIGNATURE_INVALID_METRIC = 'evo_webhook_signature_invalid_total';
const EVENT_DUPLICATES_DROPPED_METRIC =
  'evo_webhook_event_duplicates_dropped_total';

/**
 * Prometheus counters for the event-process webhook pipeline (stories 3.4, 3.5).
 *
 * Each counter is fetched from the global registry if it already exists so that
 * re-instantiating this provider (e.g. across test modules) does not throw the
 * "metric already registered" error prom-client raises on duplicate names.
 */
@Injectable()
export class EventProcessMetrics {
  readonly signatureInvalid: Counter<string>;
  readonly eventDuplicatesDropped: Counter<string>;

  constructor() {
    this.signatureInvalid =
      (register.getSingleMetric(SIGNATURE_INVALID_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: SIGNATURE_INVALID_METRIC,
        help: 'Webhook envelopes dropped because the signature was missing, invalid or unverifiable',
        labelNames: ['platform', 'reason'],
      });

    this.eventDuplicatesDropped =
      (register.getSingleMetric(EVENT_DUPLICATES_DROPPED_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: EVENT_DUPLICATES_DROPPED_METRIC,
        help: 'Webhook envelopes dropped because an identical payload was already processed within the idempotency TTL',
        labelNames: ['platform'],
      });
  }
}
