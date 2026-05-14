import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Journey } from '../journeys/entities/journey.entity';
import { JourneySession } from '../journeys/entities/journey-session.entity';
import { Segment } from '../segments/entities/segment.entity';
import { ShortLink } from '../click-tracking/entities/short-link.entity';
import { JourneyCacheService } from './services/journey-cache.service';
import { JourneySessionCacheService } from './services/journey-session-cache.service';
import { ContactCacheService } from './services/contact-cache.service';
import { SegmentCacheService } from './services/segment-cache.service';
import { LinkCacheService } from './services/link-cache.service';

/**
 * Unified Cache Module
 * Implements the same 2-layer cache pattern as segments
 * L2 (Memory) -> L1 (Redis) -> Database
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Journey, JourneySession, Segment, ShortLink]),
    EventEmitterModule,
  ],
  providers: [
    JourneyCacheService,
    JourneySessionCacheService,
    ContactCacheService,
    SegmentCacheService,
    LinkCacheService,
  ],
  exports: [
    JourneyCacheService,
    JourneySessionCacheService,
    ContactCacheService,
    SegmentCacheService,
    LinkCacheService,
  ],
})
export class CacheModule {}
