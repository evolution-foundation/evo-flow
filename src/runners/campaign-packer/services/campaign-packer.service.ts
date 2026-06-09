import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Campaign } from '../../../modules/campaigns/entities/campaign.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import {
  AudienceComputationService,
  AudienceComputationResult,
} from '../../../shared/audience/audience-computation.service';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import type { CampaignsPackContract } from '../../../shared/broker/contracts/campaigns-pack.contract';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import { isDeterministicDbError } from '../../../shared/persistence/deterministic-db-error';
import { DeterministicAudienceError } from '../../../shared/audience/errors/audience.errors';

export interface PackResult {
  audienceSize: number;
}

/**
 * First link of the distributed campaign pipeline (story 4.1 / EVO-1215):
 * loads the campaign, resolves its audience via the shared
 * `AudienceComputationService` (story 2.1) and reports the resolved size.
 *
 * Pagination + publish to `campaigns.send` (story 4.2) and full metrics
 * (story 5.2) are intentionally out of scope here.
 */
@Injectable()
export class CampaignPackerService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly audience: AudienceComputationService,
    private readonly logger: CustomLoggerService,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  async pack(payload: CampaignsPackContract): Promise<PackResult> {
    const { campaignId } = payload;

    // Explicit existence check so a missing campaign is a clean terminal
    // failure (nack false), distinct from a transient computeAudience error.
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
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

    return { audienceSize };
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
