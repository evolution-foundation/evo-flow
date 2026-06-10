import { EnricherService } from './enricher.service';
import { RecipientSourceExtractor } from './recipient-source.extractor';
import { GeoLocationService } from '../../../modules/click-tracking/services/geo-location.service';
import type { EventsReceivedContract } from '../../../shared/broker/contracts/events-received.contract';

const envelope = (
  overrides: Partial<EventsReceivedContract> = {},
): EventsReceivedContract =>
  ({
    platform: 'evolution-api',
    rawPayload: '{}',
    headers: {},
    receivedAt: '2026-06-09T12:00:00.000Z',
    sourceIp: '203.0.113.10',
    ingestionId: '00000000-0000-4000-8000-000000000000',
    correlationId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  }) as EventsReceivedContract;

describe('EnricherService', () => {
  let service: EnricherService;

  beforeEach(() => {
    // Real GeoLocationService: geoip-lite is local + deterministic, so AC2 is
    // verified end-to-end rather than against a mocked return.
    service = new EnricherService(
      new GeoLocationService(),
      new RecipientSourceExtractor(),
    );
  });

  it('parses an iPhone user-agent to a mobile device (AC1)', async () => {
    const enriched = await service.enrich(
      envelope({
        headers: {
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
        },
      }),
    );

    expect(enriched.enrichment.ua.device.type).toBe('mobile');
  });

  it('resolves geo country US for 8.8.8.8 (AC2)', async () => {
    const enriched = await service.enrich(envelope({ sourceIp: '8.8.8.8' }));

    expect(enriched.enrichment.geo.country).toBe('US');
  });

  it('flags a Googlebot user-agent as a bot (AC3)', async () => {
    const enriched = await service.enrich(
      envelope({
        headers: {
          'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
        },
      }),
    );

    expect(enriched.enrichment.botMarkers.isBot).toBe(true);
  });

  it('does not flag a normal browser user-agent as a bot', async () => {
    const enriched = await service.enrich(
      envelope({
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
        },
      }),
    );

    expect(enriched.enrichment.botMarkers.isBot).toBe(false);
  });

  it('reads the User-Agent header case-insensitively', async () => {
    const enriched = await service.enrich(
      envelope({ headers: { 'User-Agent': 'Googlebot/2.1' } }),
    );

    expect(enriched.enrichment.botMarkers.isBot).toBe(true);
  });

  it('defaults enrichment fields to empty strings for a private IP and missing UA', async () => {
    const enriched = await service.enrich(
      envelope({ sourceIp: '10.0.0.1', headers: {} }),
    );

    expect(enriched.enrichment.geo).toEqual({
      country: '',
      region: '',
      city: '',
    });
    expect(enriched.enrichment.ua.browser.name).toBe('');
    expect(enriched.enrichment.botMarkers.isDatacenter).toBe(false);
  });

  it('preserves the original envelope fields', async () => {
    const enriched = await service.enrich(
      envelope({ correlationId: '22222222-2222-4222-8222-222222222222' }),
    );

    expect(enriched.platform).toBe('evolution-api');
    expect(enriched.correlationId).toBe('22222222-2222-4222-8222-222222222222');
  });

  describe('recipient context from rawPayload (M1)', () => {
    it('prefers the SendGrid body UA/IP over the HTTP envelope', async () => {
      const enriched = await service.enrich(
        envelope({
          platform: 'sendgrid',
          // Recipient (mobile, US) in the body; provider infra (desktop UA,
          // private IP) in the HTTP envelope. The body must win.
          rawPayload: JSON.stringify([
            {
              event: 'open',
              useragent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
              ip: '8.8.8.8',
            },
          ]),
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          sourceIp: '10.0.0.1',
        }),
      );

      expect(enriched.enrichment.ua.device.type).toBe('mobile');
      expect(enriched.enrichment.geo.country).toBe('US');
    });

    it('uses the Resend body UA for bot detection', async () => {
      const enriched = await service.enrich(
        envelope({
          platform: 'resend',
          rawPayload: JSON.stringify({
            type: 'email.opened',
            data: {
              open: { userAgent: 'Googlebot/2.1', ipAddress: '8.8.8.8' },
            },
          }),
          headers: { 'user-agent': 'Mozilla/5.0 normal browser' },
          sourceIp: '10.0.0.1',
        }),
      );

      expect(enriched.enrichment.botMarkers.isBot).toBe(true);
      expect(enriched.enrichment.geo.country).toBe('US');
    });

    it('falls back to the envelope when the body carries no recipient source', async () => {
      const enriched = await service.enrich(
        envelope({
          platform: 'sendgrid',
          rawPayload: JSON.stringify([{ event: 'delivered' }]),
          headers: { 'user-agent': 'Googlebot/2.1' },
          sourceIp: '8.8.8.8',
        }),
      );

      expect(enriched.enrichment.botMarkers.isBot).toBe(true);
      expect(enriched.enrichment.geo.country).toBe('US');
    });
  });
});
