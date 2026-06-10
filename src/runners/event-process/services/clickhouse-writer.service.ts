import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { randomUUID } from 'crypto';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { getProcessingConfig } from 'src/modules/processing/config/processing.config';
import { getEventsReceivedTopic } from 'src/shared/broker/contracts/events-received.contract';
import { EnrichedEvent } from './enricher.service';
import { DlqPublisherService } from './dlq-publisher.service';
import { EventProcessMetrics } from '../metrics/event-process-metrics';

const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1_000;
// "retry 3x" per the story's AC: 1 initial attempt + 3 retries, sleeping
// 500ms/1s/2s before each retry. The DLQ payload reports `attempts: 3` (the
// retries exhausted), matching the story's example payload.
const RETRY_BACKOFF_MS = [500, 1_000, 2_000];

interface ContactEventRow {
  id: string;
  contact_id: string;
  event_type: string;
  event_name: string;
  properties: string;
  traits: string;
  anonymous_id: string | null;
  message_id: string | null;
  occurred_at: string;
  processing_time: string;
  message_raw: string;
  contact_or_anonymous_id: string;
}

interface BufferedEvent {
  row: ContactEventRow;
  source: EnrichedEvent;
}

/**
 * Micro-batching writer for `contact_events` (story 3.7 / EVO-1213).
 *
 * Buffers enriched webhook events and flushes a single batch INSERT when the
 * buffer reaches {@link BATCH_SIZE} OR {@link FLUSH_INTERVAL_MS} elapses since
 * the first buffered event — whichever comes first. The flush timer is armed
 * lazily on the first enqueue into an empty buffer and cleared on flush, so no
 * timer runs while the pipeline is idle.
 *
 * Flushes are serialized through a promise chain: a batch never interleaves
 * its retries with another batch's INSERT, and events enqueued while a flush
 * is in flight accumulate into the next batch.
 *
 * Failure handling: each batch INSERT is retried per {@link RETRY_BACKOFF_MS};
 * on exhaustion every event of the batch is handed individually to the
 * dedicated {@link DlqPublisherService} (story 3.8), which publishes to
 * `events.failed`, logs + counts its own failures and never throws — the
 * consumer must ack regardless, or the broker would redeliver a payload we
 * can no longer persist.
 *
 * Durability trade-off (inherent to the story's fire-and-forget `enqueue`):
 * the broker message is acked when `handle()` returns — BEFORE the batch is
 * inserted. A process CRASH inside the buffering/retry window (up to ~1s, or
 * ~4.5s while retrying) loses those acked events; the DLQ covers insert
 * failures, not process death. Graceful shutdown IS covered (onModuleDestroy
 * flushes). Accepting this window is what buys batched throughput (NFR28).
 *
 * DLQ reprocessing caveat (for story 3.8's runbook): re-publishing a failed
 * event back to `events.received.<platform>` within the idempotency TTL (1h)
 * is silently dropped as a duplicate — the hash covers rawPayload only.
 * Operators must wait out the TTL, clear the Redis idempotency key, or insert
 * into ClickHouse directly.
 *
 * The writer owns a thin ClickHouse client built from the shared processing
 * config: `ProcessingModule` (which exports the pooled `ClickHouseService`)
 * is not loaded under `RUN_MODE=event-process`, and importing it would drag
 * the whole legacy processing stack into this lean runner.
 */
@Injectable()
export class ClickHouseWriterService implements OnModuleDestroy {
  private readonly logger = new CustomLoggerService(
    ClickHouseWriterService.name,
  );
  private readonly table: string;

  private client: ClickHouseClient | null = null;
  private buffer: BufferedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dlqPublisher: DlqPublisherService,
    private readonly metrics: EventProcessMetrics,
  ) {
    this.table = getProcessingConfig().clickhouse?.table || 'contact_events';
  }

  enqueue(event: EnrichedEvent): void {
    this.buffer.push({ row: this.toRow(event), source: event });

    if (this.buffer.length >= BATCH_SIZE) {
      void this.scheduleFlush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(
        () => void this.scheduleFlush(),
        FLUSH_INTERVAL_MS,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.scheduleFlush();
    if (this.client) await this.client.close();
  }

  /**
   * Drains the current buffer into the flush chain. Returns the chain so
   * shutdown can await every pending batch.
   */
  private scheduleFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return this.flushChain;

    const batch = this.buffer;
    this.buffer = [];
    this.flushChain = this.flushChain.then(() => this.flushBatch(batch));
    return this.flushChain;
  }

  private async flushBatch(batch: BufferedEvent[]): Promise<void> {
    const startedAt = Date.now();

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        await this.insertRows(batch.map((entry) => entry.row));
        this.metrics.clickhouseInsertLatencyMs.observe(Date.now() - startedAt);
        this.metrics.clickhouseBatchSize.observe(batch.length);
        return;
      } catch (error) {
        if (attempt < RETRY_BACKOFF_MS.length) {
          this.metrics.clickhouseRetryTotal.inc();
          this.logger.warn('clickhouse-writer.insert.retry', {
            action: 'clickhouse-writer.insert.retry',
            attempt: attempt + 1,
            batchSize: batch.length,
            backoffMs: RETRY_BACKOFF_MS[attempt],
            error: (error as Error).message,
          });
          await this.sleep(RETRY_BACKOFF_MS[attempt]);
        } else {
          this.metrics.clickhouseTerminalFailureTotal.inc();
          this.logger.error('clickhouse-writer.insert.exhausted', {
            action: 'clickhouse-writer.insert.exhausted',
            batchSize: batch.length,
            error: (error as Error).message,
          });
          await this.publishBatchToDlq(batch);
        }
      }
    }
  }

  private async insertRows(rows: ContactEventRow[]): Promise<void> {
    await this.getClient().insert({
      table: this.table,
      values: rows,
      format: 'JSONEachRow',
    });
  }

  private async publishBatchToDlq(batch: BufferedEvent[]): Promise<void> {
    for (const { source } of batch) {
      // The ENRICHED event (envelope superset), not the bare envelope: a
      // manual reprocess can re-insert without re-running enrichment. The
      // correlationId is passed explicitly — activity contexts may lack CLS.
      // The publisher logs + counts its own failures and never throws (3.8).
      await this.dlqPublisher.publish(
        getEventsReceivedTopic(source.platform),
        source,
        'clickhouse_insert_exhausted_retries',
        RETRY_BACKOFF_MS.length,
        source.correlationId,
      );
    }
  }

  /**
   * Maps an enriched webhook event onto the existing `contact_events` schema
   * (FR17 — schema preserved). EVO-1213 D1 mapping: provider-specific contact
   * resolution is not part of this story, so the row is keyed by
   * `ingestionId` as the anonymous identity, and `correlation_id` lives
   * inside `properties` (the table has no dedicated column — OQ5 resolved).
   */
  private toRow(event: EnrichedEvent): ContactEventRow {
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      contact_id: '',
      event_type: 'track',
      event_name: `webhook.${event.platform}`,
      properties: JSON.stringify({
        platform: event.platform,
        source_ip: event.sourceIp,
        correlation_id: event.correlationId,
        ingestion_id: event.ingestionId,
        enrichment: event.enrichment,
      }),
      traits: '{}',
      anonymous_id: event.ingestionId,
      message_id: null,
      occurred_at: event.receivedAt,
      processing_time: now,
      message_raw:
        typeof event.rawPayload === 'string'
          ? event.rawPayload
          : JSON.stringify(event.rawPayload ?? null),
      contact_or_anonymous_id: event.ingestionId,
    };
  }

  private getClient(): ClickHouseClient {
    if (!this.client) {
      const ch = getProcessingConfig().clickhouse;
      this.client = createClient({
        url: `${ch?.protocol || 'http'}://${ch?.host || 'localhost'}:${ch?.port || 8123}`,
        database: ch?.database || 'evo_campaign',
        username: ch?.username || 'default',
        password: ch?.password || '',
        clickhouse_settings: {
          date_time_input_format: 'best_effort',
        },
      });
    }
    return this.client;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
