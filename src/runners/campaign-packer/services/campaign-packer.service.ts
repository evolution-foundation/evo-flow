import { Inject, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  Campaign,
  CampaignChannelType,
} from '../../../modules/campaigns/entities/campaign.entity';
import { CampaignContact } from '../../../modules/campaigns/entities/campaign-contact.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import {
  AudienceComputationService,
  AudienceComputationResult,
} from '../../../shared/audience/audience-computation.service';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_SEND_TOPIC,
  CampaignsSendContract,
  CampaignChannelType as SendChannelType,
} from '../../../shared/broker/contracts/campaigns-send.contract';
import {
  CAMPAIGNS_TRACKED_TOPIC,
  CampaignsTrackedContract,
} from '../../../shared/broker/contracts/campaigns-tracked.contract';
import type { CampaignsPackContract } from '../../../shared/broker/contracts/campaigns-pack.contract';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import { isDeterministicDbError } from '../../../shared/persistence/deterministic-db-error';
import { DeterministicAudienceError } from '../../../shared/audience/errors/audience.errors';
import { PaginationService } from './pagination.service';

export interface PackResult {
  audienceSize: number;
}

const DEFAULT_BATCH_SIZE = 1000;

// CRM stores channelType as a Rails STI class name; the broker contract uses
// the short transport identifier. Bridge the two at the publish boundary.
const CHANNEL_TYPE_TO_SEND: Record<CampaignChannelType, SendChannelType> = {
  [CampaignChannelType.EMAIL]: 'email',
  [CampaignChannelType.WHATSAPP]: 'whatsapp',
  [CampaignChannelType.SMS]: 'sms',
};

/**
 * First link of the distributed campaign pipeline (story 4.1 / EVO-1215):
 * loads the campaign, resolves its audience via the shared
 * `AudienceComputationService` (story 2.1), then (story 4.2 / EVO-1216)
 * paginates the audience and publishes one `campaigns.send` per page — or a
 * single `campaigns.tracked` with `completed: true` when the audience is empty.
 */
@Injectable()
export class CampaignPackerService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly audience: AudienceComputationService,
    private readonly logger: CustomLoggerService,
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly pagination: PaginationService,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get campaignContactRepository(): Repository<CampaignContact> {
    return this.db.getRepository(CampaignContact);
  }

  async pack(payload: CampaignsPackContract): Promise<PackResult> {
    const { campaignId, correlationId } = payload;

    // Explicit existence check so a missing campaign is a clean terminal
    // failure (nack false), distinct from a transient computeAudience error.
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
      relations: { templates: true },
    });
    if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
    }

    const result = await this.computeAudienceOrClassify(campaignId);
    const audienceSize = result.totalContacts;

    this.logger.log('campaign.packed', {
      campaignId,
      audienceSize,
      validContacts: result.validContacts,
      invalidContacts: result.invalidContacts,
      strategy: result.strategy,
    });

    const contactIds = await this.loadContactIds(campaignId);

    if (contactIds.length === 0) {
      await this.publishEmptyAudience(campaignId, correlationId);
      return { audienceSize };
    }

    await this.publishBatches(campaign, contactIds, correlationId);
    return { audienceSize };
  }

  private async loadContactIds(campaignId: string): Promise<string[]> {
    const rows = await this.campaignContactRepository.find({
      where: { campaignId },
      select: { contactId: true },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => row.contactId);
  }

  private async publishEmptyAudience(
    campaignId: string,
    correlationId: string,
  ): Promise<void> {
    this.logger.warn('campaign has no contacts', { campaignId });
    const tracked: CampaignsTrackedContract = {
      campaignId,
      page: 0,
      sentCount: 0,
      failedCount: 0,
      completed: true,
      correlationId,
    };
    await this.broker.publish(CAMPAIGNS_TRACKED_TOPIC, tracked);
  }

  private async publishBatches(
    campaign: Campaign,
    contactIds: string[],
    correlationId: string,
  ): Promise<void> {
    const channelType = this.resolveChannelType(campaign);
    const templateId = this.resolveTemplateId(campaign);
    const pages = this.pagination.split(contactIds, this.batchSize());

    this.logger.log('campaign.paginated', {
      campaignId: campaign.id,
      pages: pages.length,
      contacts: contactIds.length,
    });

    for (const page of pages) {
      const message: CampaignsSendContract = {
        campaignId: campaign.id,
        page: page.page,
        totalPages: page.totalPages,
        contactIds: page.contactIds as [string, ...string[]],
        templateId,
        channelType,
        correlationId,
      };
      await this.broker.publish(CAMPAIGNS_SEND_TOPIC, message);
    }
  }

  private batchSize(): number {
    const parsed = parseInt(
      process.env.CAMPAIGN_PACKER_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE),
      10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE;
  }

  private resolveChannelType(campaign: Campaign): SendChannelType {
    const mapped = campaign.channelType
      ? CHANNEL_TYPE_TO_SEND[campaign.channelType]
      : undefined;
    if (!mapped) {
      throw new CampaignNotConfiguredError(
        campaign.id,
        `unsupported channelType ${campaign.channelType ?? 'null'}`,
      );
    }
    return mapped;
  }

  private resolveTemplateId(campaign: Campaign): string {
    const template =
      campaign.templates?.find((t) => t.variant === 'A') ??
      campaign.templates?.[0];
    if (!template) {
      throw new CampaignNotConfiguredError(campaign.id, 'no message template');
    }
    return template.messageTemplateId;
  }

  /**
   * Run audience computation, classifying its failures for the consumer's
   * ack/nack policy. Invalid segment config already surfaces as a
   * `TerminalError` (rethrown as-is); a malformed segment SQL rejected by
   * Postgres is a deterministic DB error and is wrapped terminally so it drops
   * instead of looping. Everything else is transient and propagates to requeue.
   */
  private async computeAudienceOrClassify(
    campaignId: string,
  ): Promise<AudienceComputationResult> {
    try {
      return await this.audience.computeAudience(campaignId);
    } catch (err) {
      if (isDeterministicDbError(err)) {
        throw new DeterministicAudienceError(campaignId, err);
      }
      throw err;
    }
  }
}
