import { IncomingHttpHeaders } from 'http';
import { PayloadNormalizerService } from './payload-normalizer.service';
import { isEventsReceivedContract } from '../../../shared/broker/contracts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('PayloadNormalizerService', () => {
  const normalizer = new PayloadNormalizerService();

  const baseInput = {
    platform: 'evolution-api' as const,
    rawPayload: '{"event":"delivered"}',
    headers: { 'content-type': 'application/json' } as IncomingHttpHeaders,
    sourceIp: '203.0.113.7',
  };

  it('builds an envelope that satisfies the events.received contract', () => {
    const envelope = normalizer.build(baseInput);

    expect(isEventsReceivedContract(envelope)).toBe(true);
    expect(envelope.platform).toBe('evolution-api');
    expect(envelope.rawPayload).toBe('{"event":"delivered"}');
    expect(envelope.sourceIp).toBe('203.0.113.7');
  });

  it('generates a UUID v4 ingestionId distinct from correlationId per call', () => {
    const a = normalizer.build(baseInput);
    const b = normalizer.build(baseInput);

    expect(a.ingestionId).toMatch(UUID_V4);
    expect(a.ingestionId).not.toBe(b.ingestionId);
    // Outside an active request context the correlationId falls back to a fresh
    // UUID, which must not collide with the ingestionId.
    expect(a.ingestionId).not.toBe(a.correlationId);
    expect(a.correlationId).toMatch(UUID_V4);
  });

  it('stamps receivedAt as an ISO8601 timestamp with offset', () => {
    const envelope = normalizer.build(baseInput);
    expect(envelope.receivedAt).toBe(
      new Date(envelope.receivedAt).toISOString(),
    );
  });

  it('redacts credential-bearing headers but keeps provider signature headers', () => {
    const envelope = normalizer.build({
      ...baseInput,
      headers: {
        authorization: 'Bearer super-secret',
        cookie: 'session=abc',
        'x-api-key': 'key-123',
        'x-hub-signature-256': 'sha256=deadbeef',
        'content-type': 'application/json',
      } as IncomingHttpHeaders,
    });

    expect(envelope.headers['authorization']).toBe('[REDACTED]');
    expect(envelope.headers['cookie']).toBe('[REDACTED]');
    expect(envelope.headers['x-api-key']).toBe('[REDACTED]');
    // Signature headers must survive — story 3.4 needs them for HMAC.
    expect(envelope.headers['x-hub-signature-256']).toBe('sha256=deadbeef');
    expect(envelope.headers['content-type']).toBe('application/json');
  });

  it('flattens array-valued headers and drops undefined ones', () => {
    const envelope = normalizer.build({
      ...baseInput,
      headers: {
        'x-forwarded-for': ['203.0.113.7', '10.0.0.1'],
        'x-real-ip': '10.0.0.1',
        'x-empty': undefined,
      } as IncomingHttpHeaders,
    });

    expect(envelope.headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
    expect(envelope.headers['x-real-ip']).toBe('10.0.0.1');
    expect(envelope.headers).not.toHaveProperty('x-empty');
  });
});
