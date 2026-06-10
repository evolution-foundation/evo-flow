import { Module } from '@nestjs/common';
import { CampaignSenderService } from './services/campaign-sender.service';
import { BatchDispatcherService } from './services/batch-dispatcher.service';
import { CampaignsSendConsumer } from './consumers/campaigns-send.consumer';

/**
 * Runner module for RUN_MODE=campaign-sender (story 4.3 / EVO-1217).
 *
 * Boots the `campaigns.send` consumer, the sender service and the batch
 * dispatcher. IMESSAGE_BROKER (BrokerModule), CrmInboxDispatcher
 * (MessagingChannelsModule), ContactsClientService (CrmClientModule),
 * PipelineMetricsService (PipelineMetricsModule), CorrelationContext
 * (CorrelationModule), TenantDbContext (TenantDbContextModule) and
 * CustomLoggerService (CommonModule) are all @Global, so this module only
 * declares its own consumer + services. Imported conditionally from
 * AppModule.forRoot() when AppFactory.shouldStartCampaignSender() is true.
 */
@Module({
  providers: [
    CampaignSenderService,
    BatchDispatcherService,
    CampaignsSendConsumer,
  ],
})
export class CampaignSenderModule {}
