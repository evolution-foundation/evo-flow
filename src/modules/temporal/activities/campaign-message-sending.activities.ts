import { log } from '@temporalio/activity';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { CampaignMessageSenderService } from '../../campaigns/services/campaign-message-sender.service';
import { CampaignContactStatus } from '../../campaigns/entities/campaign-contact.entity';

let appContext: any = null;

async function getAppContext() {
  if (!appContext) {
    appContext = await NestFactory.createApplicationContext(AppModule.forRoot(), {
      logger: false,
    });
  }
  return appContext;
}

/**
 * Send messages for a batch of campaign contacts
 */
export async function sendCampaignBatchMessages(input: {
  campaignId: string;
  batchNumber: number;
  inboxId: string;
  templateId?: string;
  channelType: string;
}): Promise<{
  successfulSends: number;
  failedSends: number;
  totalContacts: number;
}> {
  log.info('Sending messages for campaign batch', {
    campaignId: input.campaignId,
    batchNumber: input.batchNumber,
  });

  try {
    const app = await getAppContext();
    const dataSource = app.get('DataSource');

    // Get batch campaign-contact rows (no JOIN with contacts — the contacts
    // table no longer exists in evo-flow Postgres). The downstream
    // CampaignMessageSenderService hydrates each contact via the CRM client.
    const contacts = await dataSource
      .getRepository('CampaignContact')
      .createQueryBuilder('cc')
      .where('cc.campaignId = :campaignId', { campaignId: input.campaignId })
      .andWhere('cc.batchSequence = :batchNumber', { batchNumber: input.batchNumber })
      .andWhere('cc.status = :status', {
        status: CampaignContactStatus.PENDING,
      })
      .getMany();

    if (!contacts || contacts.length === 0) {
      log.warn('No contacts found for batch', {
        campaignId: input.campaignId,
        batchNumber: input.batchNumber,
      });
      return {
        successfulSends: 0,
        failedSends: 0,
        totalContacts: 0,
      };
    }

    const sender = app.get(CampaignMessageSenderService);
    let successfulSends = 0;
    let failedSends = 0;

    for (const campaignContact of contacts) {
      const result = await sender.sendMessage({
        campaignId: input.campaignId,
        campaignContactId: campaignContact.id,
        contactId: campaignContact.contactId,
        inboxId: input.inboxId,
        templateId: input.templateId,
        channelType: input.channelType,
      });

      if (result.success) {
        successfulSends += 1;
      } else {
        failedSends += 1;
      }
    }

    return {
      successfulSends,
      failedSends,
      totalContacts: contacts.length,
    };
  } catch (error) {
    log.error('Failed to send campaign batch messages', {
      campaignId: input.campaignId,
      batchNumber: input.batchNumber,
      error: error.message,
    });
    throw error;
  }
}

// Export activities object for worker registration
export const campaignMessageSendingActivities = {
  sendCampaignBatchMessages,
};

// Type for workflow import
export interface CampaignMessageSendingActivities {
  sendCampaignBatchMessages(input: {
    campaignId: string;
    batchNumber: number;
    inboxId: string;
    templateId?: string;
    channelType: string;
  }): Promise<{
    successfulSends: number;
    failedSends: number;
    totalContacts: number;
  }>;
}
