import { Module } from '@nestjs/common';
import { CampaignTrackerService } from './services/campaign-tracker.service';
import { CampaignsTrackedConsumer } from './consumers/campaigns-tracked.consumer';

/**
 * Runner module for RUN_MODE=campaign-tracker (story 4.6 / EVO-1220).
 *
 * Boots the `campaigns.tracked` consumer and the tracking aggregator service —
 * the tail of the distributed dispatch pipeline that aggregates per-page
 * progress into the campaign's Postgres counters and completes the campaign.
 * IMESSAGE_BROKER (BrokerModule), CorrelationContext (CorrelationModule),
 * TenantDbContext (TenantDbContextModule) and CustomLoggerService (CommonModule)
 * are all @Global, so this module only declares its own consumer + service.
 * Imported conditionally from AppModule.forRoot() when
 * AppFactory.shouldStartCampaignTracker() is true.
 */
@Module({
  providers: [CampaignTrackerService, CampaignsTrackedConsumer],
})
export class CampaignTrackerModule {}
