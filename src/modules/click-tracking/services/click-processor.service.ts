import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { UAParser } from 'ua-parser-js';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from 'src/modules/events/events.service';
import { LinkCacheService } from 'src/modules/cache/services/link-cache.service';
import { GeoLocationService } from './geo-location.service';
import { ClickContext, CachedShortLink } from '../interfaces';
import { ShortLink } from '../entities/short-link.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

type LinkIdentifier =
  | { shortCode: string }
  | { customDomainId: string; customSlug: string };

/**
 * Click Processor Service
 * Processes click events and registers them via EventsService
 * This is the core service that handles redirects and tracking
 * Supports both default short codes and custom domain slugs
 */
@Injectable()
export class ClickProcessorService {
  private readonly logger = new CustomLoggerService(
    ClickProcessorService.name,
  );

  constructor(
    @InjectRepository(ShortLink)
    private readonly shortLinkRepository: Repository<ShortLink>,
    private readonly eventsService: EventsService,
    private readonly linkCacheService: LinkCacheService,
    private readonly geoLocationService: GeoLocationService,
  ) {}

  /**
   * Process a click on a short link
   * Main entry point for redirect handling
   * Supports both shortCode and custom domain + slug
   */
  async processClick(
    linkIdentifier: LinkIdentifier,
    request: Request,
  ): Promise<{ redirectUrl: string; tracked: boolean }> {
    try {
      // 1. Get link from cache or database
      const link = await this.findLink(linkIdentifier);

      if (!link) {
        this.logger.warn(`Short link not found: ${JSON.stringify(linkIdentifier)}`);
        return { redirectUrl: '', tracked: false };
      }

      if (!link.isActive) {
        this.logger.warn(`Short link is inactive`);
        return { redirectUrl: '', tracked: false };
      }

      // Check expiration
      if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
        this.logger.warn(`Short link expired`);
        return { redirectUrl: '', tracked: false };
      }

      // 2. Build redirect URL with parameters
      const redirectUrl = this.buildRedirectUrl(link, request);

      // 3. Extract click context from request
      const clickContext = await this.extractClickContext(link, request);

      // 4. Track the click event asynchronously (non-blocking)
      this.trackClickEvent(link, clickContext).catch((error) => {
        this.logger.error(
          `Failed to track click: ${error.message}`,
          error.stack,
        );
      });

      // 5. Increment click counter (non-blocking) - only for shortCode links
      if ('shortCode' in linkIdentifier && link.shortCode) {
        this.logger.log(
          `📈 Requesting click count increment for ${link.shortCode}`,
        );
        this.linkCacheService
          .incrementClickCount(link.shortCode)
          .then((count) => {
            this.logger.log(
              `✅ Click count increment completed for ${link.shortCode}: ${count}`,
            );
          })
          .catch((error) =>
            this.logger.warn(
              `Failed to increment click count: ${error.message}`,
            ),
          );
      }

      return { redirectUrl, tracked: true };
    } catch (error) {
      this.logger.error(
        `Error processing click: ${error.message}`,
        error.stack,
      );
      return { redirectUrl: '', tracked: false };
    }
  }

  /**
   * Find link by identifier (shortCode or customDomain + slug)
   */
  private async findLink(
    linkIdentifier: LinkIdentifier,
  ): Promise<CachedShortLink | null> {
    if ('shortCode' in linkIdentifier) {
      // Use cache for shortCode lookups (fast path)
      return await this.linkCacheService.getByShortCode(
        linkIdentifier.shortCode,
      );
    } else {
      // Query database for custom domain + slug
      const link = await this.shortLinkRepository.findOne({
        where: {
          customDomainId: linkIdentifier.customDomainId,
          customSlug: linkIdentifier.customSlug,
        },
        relations: ['parameters'],
      });

      if (!link) {
        return null;
      }

      // Transform to CachedShortLink format
      return {
        id: link.id,
        shortCode: link.shortCode,
        originalUrl: link.originalUrl,
        campaignId: link.campaignId,
        journeyId: link.journeyId,
        contactId: link.contactId,
        isActive: link.isActive,
        clickCount: link.clickCount,
        expiresAt: link.expiresAt,
        parameters: link.parameters?.map((p) => ({
          key: p.key,
          value: p.value,
          isUtm: p.isUtm,
        })),
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
        lastCached: new Date(),
      };
    }
  }

  /**
   * Build the final redirect URL with all parameters
   */
  private buildRedirectUrl(link: CachedShortLink, request: Request): string {
    try {
      const url = new URL(link.originalUrl);

      // Add link parameters from database
      if (link.parameters && link.parameters.length > 0) {
        for (const param of link.parameters) {
          url.searchParams.set(param.key, param.value);
        }
      }

      // Add query parameters from the request URL
      const requestUrl = new URL(
        request.url,
        `http://${request.headers.host}`,
      );
      for (const [key, value] of requestUrl.searchParams.entries()) {
        // Allow override of existing parameters with request params
        url.searchParams.set(key, value);
      }

      return url.toString();
    } catch (error) {
      this.logger.error(
        `Error building redirect URL: ${error.message}`,
        error.stack,
      );
      return link.originalUrl;
    }
  }

  /**
   * Extract click context from HTTP request
   */
  private async extractClickContext(
    link: CachedShortLink,
    request: Request,
  ): Promise<ClickContext> {
    // Parse User-Agent
    const ua = new UAParser(request.headers['user-agent']);
    const browser = ua.getBrowser();
    const device = ua.getDevice();
    const os = ua.getOS();

    // Get IP address (handle proxies)
    const ipAddress = this.extractIpAddress(request);

    // Get geolocation
    const geoLocation = await this.geoLocationService.getLocationFromIp(
      ipAddress,
    );

    // Extract UTM parameters
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const utmParams = this.extractUtmParameters(requestUrl);

    // Collect all custom parameters (non-UTM query params)
    const customParameters: Record<string, string> = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (!key.startsWith('utm_')) {
        customParameters[key] = value;
      }
    }

    // Build device type
    const deviceType = device.type || 'desktop';

    return {
      contactId: link.contactId,
      anonymousId: link.contactId ? undefined : uuidv4(), // Generate anonymousId if no contactId
      ipAddress,
      userAgent: request.headers['user-agent'],
      browser: browser.name
        ? `${browser.name} ${browser.version || ''}`
        : undefined,
      deviceType,
      os: os.name ? `${os.name} ${os.version || ''}` : undefined,
      country: geoLocation.country,
      region: geoLocation.region,
      city: geoLocation.city,
      latitude: geoLocation.latitude,
      longitude: geoLocation.longitude,
      timezone: geoLocation.timezone,
      referrer: this.extractReferrer(request),
      ...utmParams,
      customParameters:
        Object.keys(customParameters).length > 0
          ? customParameters
          : undefined,
    };
  }

  /**
   * Extract referrer from request headers
   */
  private extractReferrer(request: Request): string | undefined {
    const referer = request.headers['referer'];
    const referrer = request.headers['referrer'];

    if (Array.isArray(referer)) {
      return referer[0];
    }
    if (Array.isArray(referrer)) {
      return referrer[0];
    }

    return referer || referrer;
  }

  /**
   * Extract IP address from request (handle proxies and load balancers)
   */
  private extractIpAddress(request: Request): string {
    // Check common proxy headers
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor.split(',')[0];
      return ips.trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    const cfConnectingIp = request.headers['cf-connecting-ip'];
    if (cfConnectingIp) {
      return Array.isArray(cfConnectingIp)
        ? cfConnectingIp[0]
        : cfConnectingIp;
    }

    // Fallback to remote address
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  /**
   * Extract UTM parameters from URL
   */
  private extractUtmParameters(url: URL): {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
  } {
    return {
      utmSource: url.searchParams.get('utm_source') || undefined,
      utmMedium: url.searchParams.get('utm_medium') || undefined,
      utmCampaign: url.searchParams.get('utm_campaign') || undefined,
      utmTerm: url.searchParams.get('utm_term') || undefined,
      utmContent: url.searchParams.get('utm_content') || undefined,
    };
  }

  /**
   * Track click event via EventsService
   * Registers as 'link_clicked' event with all context in properties
   */
  private async trackClickEvent(
    link: CachedShortLink,
    context: ClickContext,
  ): Promise<void> {
    try {
      const messageId = uuidv4();

      this.logger.log(
        `📊 Starting to track click event for ${link.shortCode} - contactId: ${context.contactId}, anonymousId: ${context.anonymousId}`,
      );

      // Build event properties with all click data
      const properties: Record<string, any> = {
        // Link identification
        short_link_id: link.id,
        short_code: link.shortCode,
        original_url: link.originalUrl,

        // Campaign/Journey context
        campaign_id: link.campaignId,
        journey_id: link.journeyId,

        // Technical context
        ip_address: context.ipAddress,
        user_agent: context.userAgent,
        browser: context.browser,
        device_type: context.deviceType,
        os: context.os,

        // Geographic context
        country: context.country,
        region: context.region,
        city: context.city,
        latitude: context.latitude,
        longitude: context.longitude,
        timezone: context.timezone,

        // UTM parameters
        utm_source: context.utmSource,
        utm_medium: context.utmMedium,
        utm_campaign: context.utmCampaign,
        utm_term: context.utmTerm,
        utm_content: context.utmContent,

        // Referrer
        referrer: context.referrer,

        // Link parameters (stored in DB)
        link_parameters: link.parameters?.reduce(
          (acc, p) => {
            acc[p.key] = p.value;
            return acc;
          },
          {} as Record<string, string>,
        ),

        // Custom query parameters (from request)
        custom_parameters: context.customParameters,

        // Event metadata
        channel: 'link',
        event_category: 'link_engagement',
      };

      // Remove undefined values
      Object.keys(properties).forEach((key) => {
        if (properties[key] === undefined) {
          delete properties[key];
        }
      });

      // Track via EventsService
      const trackEventPayload = {
        messageId,
        contactId: context.contactId,
        anonymousId: context.anonymousId,
        event: 'link_clicked',
        properties,
        timestamp: new Date().toISOString(),
        context: {
          ip: context.ipAddress,
          userAgent: context.userAgent,
          locale: context.timezone,
          location: {
            country: context.country,
            region: context.region,
            city: context.city,
            latitude: context.latitude,
            longitude: context.longitude,
          },
        },
      };

      this.logger.log(
        `Sending track event to EventsService: ${JSON.stringify({ messageId, contactId: context.contactId, anonymousId: context.anonymousId, event: 'link_clicked' })}`,
      );

      const result = await this.eventsService.trackEvent(trackEventPayload);

      this.logger.log(
        `✅ Successfully tracked link_clicked event for short code: ${link.shortCode}, result: ${JSON.stringify(result)}`,
      );
    } catch (error) {
      this.logger.error(
        `Error tracking click event: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
