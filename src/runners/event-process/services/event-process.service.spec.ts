import { EventProcessService } from './event-process.service';
import { SignatureValidatorRegistry } from './signature-validator.registry';
import { EventProcessMetrics } from '../metrics/event-process-metrics';
import { IdempotencyService } from 'src/shared/idempotency/idempotency.service';
import { EnricherService } from './enricher.service';
import { ClickHouseWriterService } from './clickhouse-writer.service';

describe('EventProcessService', () => {
  let service: EventProcessService;
  let validate: jest.Mock;
  let forPlatform: jest.Mock;
  let inc: jest.Mock;
  let duplicatesInc: jest.Mock;
  let computeHash: jest.Mock;
  let checkAndMark: jest.Mock;
  let enrich: jest.Mock;
  let enqueue: jest.Mock;

  const validEnvelope = {
    platform: 'evolution-api',
    rawPayload: 'raw-body-bytes',
    headers: { apikey: 'tok' },
    receivedAt: '2026-06-08T12:00:00.000Z',
    sourceIp: '203.0.113.10',
    ingestionId: '00000000-0000-4000-8000-000000000000',
    correlationId: '11111111-1111-4111-8111-111111111111',
  };

  beforeEach(() => {
    validate = jest.fn().mockReturnValue(true);
    forPlatform = jest
      .fn()
      .mockReturnValue({ platform: 'evolution-api', validate });
    inc = jest.fn();
    duplicatesInc = jest.fn();
    computeHash = jest.fn((payload: string) => `hash:${payload}`);
    checkAndMark = jest.fn().mockResolvedValue(true);
    enrich = jest.fn(
      (envelope: unknown): Promise<Record<string, unknown>> =>
        Promise.resolve({
          ...(envelope as Record<string, unknown>),
          enrichment: { ua: {}, geo: {}, botMarkers: {} },
        }),
    );
    enqueue = jest.fn();
    service = new EventProcessService(
      { for: forPlatform } as unknown as SignatureValidatorRegistry,
      {
        signatureInvalid: { inc },
        eventDuplicatesDropped: { inc: duplicatesInc },
      } as unknown as EventProcessMetrics,
      { computeHash, checkAndMark } as unknown as IdempotencyService,
      { enrich } as unknown as EnricherService,
      { enqueue } as unknown as ClickHouseWriterService,
    );
  });

  it('processes a valid envelope whose signature verifies (no drop metric)', async () => {
    await expect(service.handle(validEnvelope)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith('raw-body-bytes', { apikey: 'tok' });
    expect(inc).not.toHaveBeenCalled();
  });

  it('enriches the event and hands it to the ClickHouse writer (story 3.7)', async () => {
    await service.handle(validEnvelope);

    expect(enrich).toHaveBeenCalledWith(validEnvelope);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'evolution-api',
        enrichment: { ua: {}, geo: {}, botMarkers: {} },
      }),
    );
  });

  it('does not enrich or enqueue dropped envelopes (invalid signature / duplicate)', async () => {
    validate.mockReturnValueOnce(false);
    await service.handle(validEnvelope);

    validate.mockReturnValue(true);
    checkAndMark.mockResolvedValueOnce(false);
    await service.handle(validEnvelope);

    expect(enrich).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws for a payload that is not a valid envelope', async () => {
    await expect(service.handle({ not: 'an-envelope' })).rejects.toThrow(
      /not a valid events.received envelope/,
    );
  });

  it('throws for a known-shape envelope with an invalid platform', async () => {
    await expect(
      service.handle({ ...validEnvelope, platform: 'not-a-platform' }),
    ).rejects.toThrow();
  });

  it('drops (acks, no throw) and counts the metric when the signature is invalid (AC2)', async () => {
    validate.mockReturnValue(false);

    await expect(service.handle(validEnvelope)).resolves.toBeUndefined();

    expect(inc).toHaveBeenCalledWith({
      platform: 'evolution-api',
      reason: 'invalid_signature',
    });
  });

  it('drops with a warning when no validator is registered for the platform (AC3)', async () => {
    forPlatform.mockReturnValue(null);

    await expect(
      service.handle({ ...validEnvelope, platform: 'unknown' }),
    ).resolves.toBeUndefined();

    expect(validate).not.toHaveBeenCalled();
    expect(inc).toHaveBeenCalledWith({
      platform: 'unknown',
      reason: 'no_validator',
    });
  });

  it('awaits an async validator (SES/SNS path)', async () => {
    validate.mockResolvedValue(false);

    await expect(service.handle(validEnvelope)).resolves.toBeUndefined();

    expect(inc).toHaveBeenCalledWith({
      platform: 'evolution-api',
      reason: 'invalid_signature',
    });
  });

  describe('idempotency (story 3.5)', () => {
    it('drops the second identical message and counts the metric (AC1)', async () => {
      checkAndMark.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.handle(validEnvelope)).resolves.toBeUndefined();
      await expect(service.handle(validEnvelope)).resolves.toBeUndefined();

      expect(checkAndMark).toHaveBeenCalledTimes(2);
      expect(duplicatesInc).toHaveBeenCalledTimes(1);
      expect(duplicatesInc).toHaveBeenCalledWith({ platform: 'evolution-api' });
    });

    it('hashes only the rawPayload, so a bit-different payload is not a duplicate (AC2)', async () => {
      await service.handle(validEnvelope);
      await service.handle({
        ...validEnvelope,
        rawPayload: 'raw-body-bytes-X',
      });

      expect(computeHash).toHaveBeenNthCalledWith(1, 'raw-body-bytes');
      expect(computeHash).toHaveBeenNthCalledWith(2, 'raw-body-bytes-X');
      expect(duplicatesInc).not.toHaveBeenCalled();
    });

    it('runs the idempotency check only after signature validation passes', async () => {
      validate.mockReturnValue(false);

      await service.handle(validEnvelope);

      expect(checkAndMark).not.toHaveBeenCalled();
    });
  });
});
