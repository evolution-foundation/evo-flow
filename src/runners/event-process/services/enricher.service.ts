import { Injectable } from '@nestjs/common';
import { UAParser } from 'ua-parser-js';
import { EventsReceivedContract } from '../../../shared/broker/contracts/events-received.contract';
import { EventsEnrichedContract } from '../../../shared/broker/contracts/events-enriched.contract';
import { GeoLocationService } from '../../../modules/click-tracking/services/geo-location.service';
import { RecipientSourceExtractor } from './recipient-source.extractor';

type Enrichment = EventsEnrichedContract['enrichment'];

export type EnrichedEvent = EventsReceivedContract & {
  enrichment: Enrichment;
};

// Prefix/substring tokens that mark a request as a known crawler. MVP list
// (story 3.6); broader bot/datacenter detection is deferred to Growth.
const BOT_UA_DENYLIST = [
  'googlebot',
  'bingbot',
  'ahrefsbot',
  'semrushbot',
  'dotbot',
  'mj12bot',
  'yandexbot',
];

/**
 * Enriches a received webhook envelope (story 3.6 / EVO-1212) with parsed
 * user-agent, IP geolocation and basic bot markers before the event-process
 * pipeline persists it. Reuses the existing `GeoLocationService` (geoip-lite)
 * and `ua-parser-js`. The enriched event is consumed by the ClickHouse writer
 * wired into `EventProcessService.handle()` in story 3.7.
 */
@Injectable()
export class EnricherService {
  constructor(
    private readonly geoLocation: GeoLocationService,
    private readonly recipientSource: RecipientSourceExtractor,
  ) {}

  async enrich(envelope: EventsReceivedContract): Promise<EnrichedEvent> {
    // Prefer the recipient's UA/IP carried in the provider payload; fall back
    // to the HTTP envelope (provider infra) when the body doesn't carry it.
    const recipient = this.recipientSource.extract(
      envelope.platform,
      this.parsePayload(envelope.rawPayload),
    );
    const userAgent =
      recipient.userAgent ?? this.extractUserAgent(envelope.headers);
    const ip = recipient.ip ?? envelope.sourceIp;

    return {
      ...envelope,
      enrichment: {
        ua: this.parseUserAgent(userAgent),
        geo: await this.resolveGeo(ip),
        botMarkers: {
          isBot: this.isBot(userAgent),
          isDatacenter: false,
        },
      },
    };
  }

  private parsePayload(rawPayload: unknown): unknown {
    if (typeof rawPayload !== 'string') return rawPayload;
    try {
      return JSON.parse(rawPayload);
    } catch {
      return undefined;
    }
  }

  private extractUserAgent(headers: Record<string, string>): string {
    const key = Object.keys(headers).find(
      (header) => header.toLowerCase() === 'user-agent',
    );
    return key ? headers[key] : '';
  }

  private parseUserAgent(userAgent: string): Enrichment['ua'] {
    const parsed = new UAParser(userAgent);
    const browser = parsed.getBrowser();
    const os = parsed.getOS();
    const device = parsed.getDevice();

    return {
      browser: { name: browser.name ?? '', version: browser.version ?? '' },
      os: { name: os.name ?? '', version: os.version ?? '' },
      device: {
        type: device.type ?? '',
        vendor: device.vendor ?? '',
        model: device.model ?? '',
      },
    };
  }

  private async resolveGeo(sourceIp: string): Promise<Enrichment['geo']> {
    const geo = await this.geoLocation.getLocationFromIp(sourceIp);
    return {
      country: geo.country ?? '',
      region: geo.region ?? '',
      city: geo.city ?? '',
    };
  }

  private isBot(userAgent: string): boolean {
    const normalized = userAgent.toLowerCase();
    return BOT_UA_DENYLIST.some((bot) => normalized.includes(bot));
  }
}
