const mockInsert = jest.fn();
const mockClose = jest.fn();

jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(() => ({ insert: mockInsert, close: mockClose })),
}));

import { ClickHouseWriterService } from './clickhouse-writer.service';
import { EventProcessMetrics } from '../metrics/event-process-metrics';
import { DlqPublisherService } from './dlq-publisher.service';
import { EnrichedEvent } from './enricher.service';

function makeEvent(seq: number): EnrichedEvent {
  return {
    platform: 'evolution-api',
    rawPayload: `{"seq":${seq}}`,
    headers: { 'content-type': 'application/json' },
    receivedAt: '2026-06-10T12:00:00.000Z',
    sourceIp: '203.0.113.10',
    ingestionId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    correlationId: `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`,
    enrichment: {
      ua: {
        browser: { name: 'Chrome', version: '125' },
        os: { name: 'iOS', version: '17' },
        device: { type: 'mobile', vendor: 'Apple', model: 'iPhone' },
      },
      geo: { country: 'US', region: 'CA', city: 'SF' },
      botMarkers: { isBot: false, isDatacenter: false },
    },
  } as EnrichedEvent;
}

describe('ClickHouseWriterService', () => {
  let service: ClickHouseWriterService;
  let publish: jest.Mock;
  let metrics: {
    clickhouseInsertLatencyMs: { observe: jest.Mock };
    clickhouseBatchSize: { observe: jest.Mock };
    clickhouseRetryTotal: { inc: jest.Mock };
    clickhouseTerminalFailureTotal: { inc: jest.Mock };
    dlqPublishFailedTotal: { inc: jest.Mock };
  };

  const pendingFlushes = () =>
    (service as unknown as { flushChain: Promise<void> }).flushChain;

  interface InsertArg {
    table: string;
    format: string;
    values: Array<Record<string, string | null>>;
  }
  const insertArg = (call = 0): InsertArg =>
    (mockInsert.mock.calls as unknown as [InsertArg][])[call][0];

  beforeEach(() => {
    jest.useFakeTimers();
    mockInsert.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    publish = jest.fn().mockResolvedValue(undefined);
    // The real DlqPublisherService never throws (3.8) — the mock mirrors that.
    metrics = {
      clickhouseInsertLatencyMs: { observe: jest.fn() },
      clickhouseBatchSize: { observe: jest.fn() },
      clickhouseRetryTotal: { inc: jest.fn() },
      clickhouseTerminalFailureTotal: { inc: jest.fn() },
      dlqPublishFailedTotal: { inc: jest.fn() },
    };
    service = new ClickHouseWriterService(
      { publish } as unknown as DlqPublisherService,
      metrics as unknown as EventProcessMetrics,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flushes one batch INSERT of 100 when 100 events arrive within 1s (AC1)', async () => {
    for (let i = 0; i < 100; i++) service.enqueue(makeEvent(i));
    await pendingFlushes();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const { table, values, format } = insertArg();
    expect(table).toBe('contact_events');
    expect(format).toBe('JSONEachRow');
    expect(values).toHaveLength(100);
    expect(metrics.clickhouseBatchSize.observe).toHaveBeenCalledWith(100);
  });

  it('flushes a partial batch of 50 when the 1s timer fires (AC2)', async () => {
    for (let i = 0; i < 50; i++) service.enqueue(makeEvent(i));
    expect(mockInsert).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await pendingFlushes();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(insertArg().values).toHaveLength(50);
  });

  it('retries 3x with exponential backoff then hands each event to the DLQ publisher (AC3)', async () => {
    mockInsert.mockRejectedValue(new Error('connect ECONNREFUSED'));

    service.enqueue(makeEvent(1));
    service.enqueue(makeEvent(2));

    // 1s flush timer + 500ms + 1s + 2s backoffs between the 4 attempts.
    await jest.advanceTimersByTimeAsync(1_000 + 500 + 1_000 + 2_000 + 50);
    await pendingFlushes();

    expect(mockInsert).toHaveBeenCalledTimes(4);
    expect(metrics.clickhouseRetryTotal.inc).toHaveBeenCalledTimes(3);
    expect(metrics.clickhouseTerminalFailureTotal.inc).toHaveBeenCalledTimes(1);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      1,
      'events.received.evolution-api',
      expect.objectContaining({ ingestionId: makeEvent(1).ingestionId }),
      'clickhouse_insert_exhausted_retries',
      3,
      makeEvent(1).correlationId,
    );
  });

  it('recovers on a retry without touching the DLQ', async () => {
    mockInsert
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    for (let i = 0; i < 100; i++) service.enqueue(makeEvent(i));
    await jest.advanceTimersByTimeAsync(500 + 50);
    await pendingFlushes();

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    expect(metrics.clickhouseRetryTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('maps the enriched event onto the contact_events schema (D1 + OQ5)', async () => {
    service.enqueue(makeEvent(7));
    await service.onModuleDestroy();

    const row = insertArg().values[0];
    expect(row.event_type).toBe('track');
    expect(row.event_name).toBe('webhook.evolution-api');
    expect(row.contact_id).toBe('');
    expect(row.contact_or_anonymous_id).toBe(makeEvent(7).ingestionId);
    expect(row.occurred_at).toBe('2026-06-10T12:00:00.000Z');
    expect(row.message_raw).toBe('{"seq":7}');

    const properties = JSON.parse(row.properties as string) as {
      correlation_id: string;
      enrichment: { geo: { country: string } };
    };
    expect(properties.correlation_id).toBe(makeEvent(7).correlationId);
    expect(properties.enrichment.geo.country).toBe('US');
  });

  it('flushes the remaining buffer and closes the client on shutdown', async () => {
    for (let i = 0; i < 5; i++) service.enqueue(makeEvent(i));

    await service.onModuleDestroy();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(insertArg().values).toHaveLength(5);
    expect(mockClose).toHaveBeenCalled();
  });

  it('events enqueued during an in-flight flush land in the next batch', async () => {
    let release!: () => void;
    mockInsert.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    for (let i = 0; i < 100; i++) service.enqueue(makeEvent(i));
    // Yield so the chained flush starts (and `release` is assigned) before we
    // enqueue into the next batch and release the in-flight INSERT.
    await jest.advanceTimersByTimeAsync(0);
    service.enqueue(makeEvent(999));

    release();
    await jest.advanceTimersByTimeAsync(1_000);
    await pendingFlushes();

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(insertArg(0).values).toHaveLength(100);
    expect(insertArg(1).values).toHaveLength(1);
  });
});
