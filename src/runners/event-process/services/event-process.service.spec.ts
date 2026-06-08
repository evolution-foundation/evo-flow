import { EventProcessService } from './event-process.service';

describe('EventProcessService', () => {
  const service = new EventProcessService();

  const validEnvelope = {
    platform: 'evolution-api',
    rawPayload: { hello: 'world' },
    headers: { 'x-test': '1' },
    receivedAt: '2026-06-08T12:00:00.000Z',
    sourceIp: '203.0.113.10',
    ingestionId: '00000000-0000-4000-8000-000000000000',
    correlationId: '11111111-1111-4111-8111-111111111111',
  };

  it('resolves for a valid events.received envelope', async () => {
    await expect(service.handle(validEnvelope)).resolves.toBeUndefined();
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
});
