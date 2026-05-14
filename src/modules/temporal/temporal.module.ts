import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JourneySession } from '../journeys/entities/journey-session.entity';
import { Journey } from '../journeys/entities/journey.entity';
import { Campaign } from '../campaigns/entities/campaign.entity';
import { CacheModule } from '../cache/cache.module';
import { EventsModule } from '../events/events.module';
import { ProcessingModule } from '../processing/processing.module';
import { TemporalWorkerService } from './temporal-worker.service';
import { CampaignWorkerService } from './campaign-worker.service';
import { JourneyTrackingService } from './services/journey-tracking.service';
import { CampaignsModule } from '../campaigns/campaigns.module';

/**
 * Temporal Module
 * Handles Temporal.io workflow orchestration and activities
 * Only loaded when RUN_MODE includes TEMPORAL-WORKER or CAMPAIGN-WORKER
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      JourneySession,
      Journey,
      Campaign,
    ]),
    EventEmitterModule,
    CacheModule,
    EventsModule,
    ProcessingModule,
    CampaignsModule, // For campaign activities
  ],
  providers: [
    TemporalWorkerService,
    CampaignWorkerService,
    JourneyTrackingService,
  ],
  exports: [
    TemporalWorkerService,
    CampaignWorkerService,
    JourneyTrackingService,
  ],
})
export class TemporalModule {}
