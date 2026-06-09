import { Module } from '@nestjs/common';
import { CampaignPackerService } from './services/campaign-packer.service';
import { CampaignsPackConsumer } from './consumers/campaigns-pack.consumer';

/**
 * Runner module for RUN_MODE=campaign-packer (story 4.1 / EVO-1215).
 *
 * Boots the `campaigns.pack` consumer and the packer service. IMESSAGE_BROKER
 * (BrokerModule), AudienceComputationService (AudienceModule), CorrelationContext
 * (CorrelationModule), TenantDbContext (TenantDbContextModule) and
 * CustomLoggerService (CommonModule) are all @Global, so this module only
 * declares its own consumer + service. Imported conditionally from
 * AppModule.forRoot() when AppFactory.shouldStartCampaignPacker() is true.
 */
@Module({
  providers: [CampaignPackerService, CampaignsPackConsumer],
})
export class CampaignPackerModule {}
