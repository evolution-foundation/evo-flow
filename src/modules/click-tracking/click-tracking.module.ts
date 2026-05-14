import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';

// Entities
import { ShortLink, LinkParameter, CustomDomain } from './entities';

// Services
import {
  ClickProcessorService,
  ClickTrackingService,
  GeoLocationService,
  UrlShortenerService,
  CustomDomainsService,
} from './services';

// Controllers
import {
  ClickTrackingController,
  RedirectController,
  CustomDomainsController,
} from './controllers';

// External modules
import { EventsModule } from '../events/events.module';
import { ProcessingModule } from '../processing/processing.module';

/**
 * Click Tracking Module
 * Complete URL shortener and click tracking system
 *
 * Features:
 * - Short URL generation and management
 * - Custom domain support with DNS verification
 * - Click tracking with EventsService integration
 * - 2-layer cache (Memory + Redis) for fast redirects
 * - Analytics via ClickHouse
 * - UTM and custom parameter tracking
 * - Geolocation and device detection
 *
 * Endpoints:
 * - GET /:shortCode - Public redirect endpoint (supports custom domains)
 * - /click-tracking/* - Authenticated link management API
 * - /click-analytics/* - Authenticated analytics API
 * - /custom-domains/* - Authenticated custom domain management API
 */
@Module({
  imports: [
    // TypeORM entities
    TypeOrmModule.forFeature([ShortLink, LinkParameter, CustomDomain]),

    // Event emitter for cache invalidation
    EventEmitterModule,

    // External dependencies
    EventsModule, // For tracking clicks via EventsService
    ProcessingModule, // For ClickHouse analytics queries
  ],
  controllers: [
    // Public redirect controller (no auth)
    RedirectController,

    // Authenticated controllers
    ClickTrackingController,
    CustomDomainsController,
  ],
  providers: [
    // Core services
    ClickTrackingService,
    ClickProcessorService,
    CustomDomainsService,

    // Utility services
    UrlShortenerService,
    GeoLocationService,
  ],
  exports: [
    // Export services for use in other modules
    ClickTrackingService,
    ClickProcessorService,
    CustomDomainsService,
  ],
})
export class ClickTrackingModule {}
