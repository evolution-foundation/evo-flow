import { EventProcessService } from './event-process.service';
import { SignatureValidatorRegistry } from './signature-validator.registry';
import { EventProcessMetrics } from '../metrics/event-process-metrics';

describe('EventProcessService', () => {
  let service: EventProcessService;
  let validate: jest.Mock;
  let forPlatform: jest.Mock;
  let inc: jest.Mock;

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
    service = new EventProcessService(
      { for: forPlatform } as unknown as SignatureValidatorRegistry,
      { signatureInvalid: { inc } } as unknown as EventProcessMetrics,
    );
  });

  it('processes a valid envelope whose signature verifies (no drop metric)', async () => {
    await expect(service.handle(validEnvelope)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith('raw-body-bytes', { apikey: 'tok' });
    expect(inc).not.toHaveBeenCalled();
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
});
