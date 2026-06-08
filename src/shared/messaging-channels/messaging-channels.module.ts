import { Global, Module } from '@nestjs/common';
import { CrmInboxDispatcher } from './dispatchers/crm-inbox.dispatcher';

/**
 * Global module exposing the channel dispatch seam (story 2.2 / EVO-1202).
 * Consumed by CampaignMessageSenderService today and by the future
 * campaign-sender (Epic 4) so HTTP dispatch lives in one place.
 */
@Global()
@Module({
  providers: [CrmInboxDispatcher],
  exports: [CrmInboxDispatcher],
})
export class MessagingChannelsModule {}
