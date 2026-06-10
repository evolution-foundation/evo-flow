import { Injectable } from '@nestjs/common';
import { Counter, Histogram, register } from 'prom-client';

const SIGNATURE_INVALID_METRIC = 'evo_webhook_signature_invalid_total';
const EVENT_DUPLICATES_DROPPED_METRIC =
  'evo_webhook_event_duplicates_dropped_total';
const CLICKHOUSE_INSERT_LATENCY_METRIC = 'evo_clickhouse_insert_latency_ms';
const CLICKHOUSE_BATCH_SIZE_METRIC = 'evo_clickhouse_batch_size';
const CLICKHOUSE_RETRY_METRIC = 'evo_clickhouse_retry_total';
const CLICKHOUSE_TERMINAL_FAILURE_METRIC =
  'evo_clickhouse_terminal_failure_total';
const DLQ_PUBLISH_FAILED_METRIC = 'evo_dlq_publish_failed_total';
const EVENTS_FAILED_PUBLISHED_METRIC = 'evo_events_failed_published_total';

/**
 * Prometheus metrics for the event-process webhook pipeline (stories 3.4, 3.5,
 * 3.7, 3.8).
 *
 * Each metric is fetched from the global registry if it already exists so that
 * re-instantiating this provider (e.g. across test modules) does not throw the
 * "metric already registered" error prom-client raises on duplicate names.
 */
@Injectable()
export class EventProcessMetrics {
  readonly signatureInvalid: Counter<string>;
  readonly eventDuplicatesDropped: Counter<string>;
  readonly clickhouseInsertLatencyMs: Histogram<string>;
  readonly clickhouseBatchSize: Histogram<string>;
  readonly clickhouseRetryTotal: Counter<string>;
  readonly clickhouseTerminalFailureTotal: Counter<string>;
  readonly dlqPublishFailedTotal: Counter<string>;
  readonly eventsFailedPublishedTotal: Counter<string>;

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

    this.clickhouseInsertLatencyMs =
      (register.getSingleMetric(CLICKHOUSE_INSERT_LATENCY_METRIC) as
        | Histogram<string>
        | undefined) ??
      new Histogram({
        name: CLICKHOUSE_INSERT_LATENCY_METRIC,
        help: 'Latency of contact_events batch INSERTs into ClickHouse, in milliseconds',
        buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      });

    this.clickhouseBatchSize =
      (register.getSingleMetric(CLICKHOUSE_BATCH_SIZE_METRIC) as
        | Histogram<string>
        | undefined) ??
      new Histogram({
        name: CLICKHOUSE_BATCH_SIZE_METRIC,
        help: 'Number of events per contact_events batch INSERT',
        buckets: [1, 5, 10, 25, 50, 75, 100],
      });

    this.clickhouseRetryTotal =
      (register.getSingleMetric(CLICKHOUSE_RETRY_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: CLICKHOUSE_RETRY_METRIC,
        help: 'ClickHouse batch INSERT attempts that failed and were retried',
      });

    this.clickhouseTerminalFailureTotal =
      (register.getSingleMetric(CLICKHOUSE_TERMINAL_FAILURE_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: CLICKHOUSE_TERMINAL_FAILURE_METRIC,
        help: 'ClickHouse batches dropped to events.failed after exhausting retries',
      });

    this.dlqPublishFailedTotal =
      (register.getSingleMetric(DLQ_PUBLISH_FAILED_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: DLQ_PUBLISH_FAILED_METRIC,
        help: 'events.failed publishes that themselves failed — the last resort failed, operators must look',
      });

    this.eventsFailedPublishedTotal =
      (register.getSingleMetric(EVENTS_FAILED_PUBLISHED_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: EVENTS_FAILED_PUBLISHED_METRIC,
        help: 'Events published to the events.failed DLQ, labelled by failure reason for granular alerting',
        labelNames: ['reason'],
      });
  }
}
