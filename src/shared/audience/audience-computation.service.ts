import { Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Campaign } from '../../modules/campaigns/entities/campaign.entity';
import {
  CampaignContact,
  CampaignContactStatus,
} from '../../modules/campaigns/entities/campaign-contact.entity';
import { TenantDbContext } from '../../evo-extension-points';
import { SegmentComputationService } from '../../modules/segments/services/segment-computation.service';
import { SegmentQueryBuilderService } from './segment-query-builder.service';
import { ContactsClientService } from '../crm-client/contacts-client.service';
import {
  mapContactDto,
  type HydratedContact,
} from '../crm-client/types/contact';

export interface AudienceComputationResult {
  campaignId: string;
  totalContacts: number;
  validContacts: number;
  invalidContacts: number;
  processingTimeMs: number;
  strategy: string;
}

/**
 * Service responsible for computing campaign audiences and populating
 * campaigns_contacts.
 *
 * Q3 cleanup: the `contacts` table no longer lives in evo-flow Postgres. The
 * pipeline is now:
 *   1. Resolve candidate `contact_ids` from a local source (segment math in
 *      ClickHouse / Postgres `computed_property_assignments_v2`, taggings,
 *      user SQL, or CRM list endpoint for sendToAll).
 *   2. Bulk fetch full DTOs via `ContactsClientService.findByIds`.
 *   3. Validate / filter / persist in memory.
 *
 * `computed_property_assignments_v2` stays local — it's a ClickHouse-style
 * table owned by evo-flow's segmentation system. We only stop joining it
 * with the local `contacts` table; the assignment table itself is unchanged.
 */
@Injectable()
export class AudienceComputationService {
  private readonly logger = new Logger(AudienceComputationService.name);

  constructor(
    private readonly db: TenantDbContext,
    private readonly segmentQueryBuilder: SegmentQueryBuilderService,
    private readonly segmentComputationService: SegmentComputationService,
    private readonly contactsClient: ContactsClientService,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get campaignContactRepository(): Repository<CampaignContact> {
    return this.db.getRepository(CampaignContact);
  }

  /**
   * Main method to compute and populate campaign audience
   */
  async computeAudience(
    campaignId: string,
  ): Promise<AudienceComputationResult> {
    const startTime = Date.now();

    this.logger.log(`Computing audience for campaign ${campaignId}`);

    // Get campaign
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Clear existing audience
    await this.clearAudience(campaignId);

    // Determine segmentation strategy
    const query =
      await this.segmentQueryBuilder.analyzeSegmentationStrategy(campaign);

    this.logger.log(
      `Using segmentation strategy: ${query.type} for campaign ${campaignId}`,
    );

    let contactIds: string[] = [];
    let totalContacts = 0;

    // Execute query based on strategy
    if (query.type === 'segment' && query.segmentId) {
      // Use segments module for advanced segmentation
      const result = await this.computeFromSegment(campaign, query.segmentId);
      contactIds = result.contactIds;
      totalContacts = result.total;
    } else {
      // Use direct queries for simpler cases
      const result = await this.segmentQueryBuilder.executeAudienceQuery(
        campaign,
        query,
      );
      contactIds = result.contactIds;
      totalContacts = result.total;
    }

    this.logger.log(
      `Found ${totalContacts} contacts for campaign ${campaignId}`,
    );

    // Populate campaigns_contacts with validation
    const populationResult = await this.populateCampaignContacts(
      campaign,
      contactIds,
    );

    const processingTimeMs = Date.now() - startTime;

    this.logger.log(
      `Audience computation completed for campaign ${campaignId}: ${populationResult.validContacts} valid, ${populationResult.invalidContacts} invalid (${processingTimeMs}ms)`,
    );

    return {
      campaignId,
      totalContacts,
      validContacts: populationResult.validContacts,
      invalidContacts: populationResult.invalidContacts,
      processingTimeMs,
      strategy: query.type,
    };
  }

  /**
   * Compute audience from existing segment using segments module.
   * Queries `computed_property_assignments_v2` directly for matching
   * `contact_id`s (no JOIN with the contacts table — that table doesn't
   * exist in evo-flow Postgres anymore).
   */
  private async computeFromSegment(
    campaign: Campaign,
    segmentId: string,
  ): Promise<{ contactIds: string[]; total: number }> {
    this.logger.log(
      `Computing audience from segment ${segmentId} for campaign ${campaign.id}`,
    );

    const segment = await this.segmentQueryBuilder.getSegment(segmentId);

    // If campaign requires running segmentation, recompute the segment
    if (campaign.isRunSegment) {
      this.logger.log(`Recomputing segment ${segmentId}`);
      await this.segmentComputationService.computeSegment(segment.id);
    }

    // Pull contact ids directly from the assignment table.
    const rows = await this.campaignContactRepository.manager.query(
      `SELECT DISTINCT cpa.contact_id AS id
       FROM computed_property_assignments_v2 cpa
       WHERE cpa.computed_property_id = $1
         AND cpa.type = $2
         AND cpa.segment_value = $3`,
      [segmentId, 'segment', true],
    );

    const contactIds = rows.map((r: any) => r.id);

    return {
      contactIds,
      total: contactIds.length,
    };
  }

  /**
   * Populate campaigns_contacts table with contact IDs.
   * Hydrates contact data via the CRM client, filters via channel validation
   * (which also drops `blocked` contacts), then batch-inserts.
   */
  private async populateCampaignContacts(
    campaign: Campaign,
    contactIds: string[],
  ): Promise<{ validContacts: number; invalidContacts: number }> {
    if (contactIds.length === 0) {
      this.logger.warn(`No contacts to populate for campaign ${campaign.id}`);
      return { validContacts: 0, invalidContacts: 0 };
    }

    this.logger.log(
      `Populating ${contactIds.length} contacts for campaign ${campaign.id}`,
    );

    const dtos = await this.contactsClient.findByIds(contactIds);
    const contacts = dtos
      .map((dto) => mapContactDto(dto))
      .filter((c): c is HydratedContact => c !== null);

    let validContacts = 0;
    let invalidContacts = 0;
    const campaignContactsToInsert: Partial<CampaignContact>[] = [];

    for (const contact of contacts) {
      const validation = this.segmentQueryBuilder.validateContactForChannel(
        contact,
        campaign.channelType || '',
      );

      if (validation.valid) {
        campaignContactsToInsert.push({
          campaignId: campaign.id,
          contactId: contact.id,
          status: CampaignContactStatus.PENDING,
        });
        validContacts++;
      } else {
        this.logger.debug(
          `Contact ${contact.id} invalid for campaign ${campaign.id}: ${validation.reason}`,
        );
        invalidContacts++;
      }
    }

    // Account for ids that disappeared from the CRM (404). They count as
    // invalid in the report.
    invalidContacts += contactIds.length - contacts.length;

    const chunkSize = 1000;
    for (let i = 0; i < campaignContactsToInsert.length; i += chunkSize) {
      const chunk = campaignContactsToInsert.slice(i, i + chunkSize);
      await this.campaignContactRepository
        .createQueryBuilder()
        .insert()
        .into(CampaignContact)
        .values(chunk)
        .execute();

      this.logger.debug(
        `Inserted chunk ${i / chunkSize + 1} of ${Math.ceil(campaignContactsToInsert.length / chunkSize)} for campaign ${campaign.id}`,
      );
    }

    return { validContacts, invalidContacts };
  }

  /**
   * Clear existing audience for a campaign
   */
  async clearAudience(campaignId: string): Promise<{ deleted: number }> {
    this.logger.log(`Clearing audience for campaign ${campaignId}`);

    const result = await this.campaignContactRepository.delete({
      campaignId,
    });

    this.logger.log(
      `Cleared ${result.affected || 0} contacts for campaign ${campaignId}`,
    );

    return { deleted: result.affected || 0 };
  }

  /**
   * Get audience count without full computation
   */
  async getAudienceCount(campaignId: string): Promise<number> {
    return this.campaignContactRepository.count({
      where: {
        campaignId,
      },
    });
  }

  /**
   * Get paginated audience for preview. Returns hydrated DTOs from CRM.
   */
  async getAudiencePreview(
    campaignId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ contacts: HydratedContact[]; total: number }> {
    const [campaignContacts, total] =
      await this.campaignContactRepository.findAndCount({
        where: {
          campaignId,
        },
        skip: offset,
        take: limit,
        order: {
          createdAt: 'ASC',
        },
      });

    const contactIds = campaignContacts.map((cc) => cc.contactId);

    if (contactIds.length === 0) {
      return { contacts: [], total: 0 };
    }

    const dtos = await this.contactsClient.findByIds(contactIds);
    const contacts = dtos
      .map((dto) => mapContactDto(dto))
      .filter((c): c is HydratedContact => c !== null);

    return { contacts, total };
  }

  /**
   * Estimate audience size without populating campaigns_contacts.
   */
  async estimateAudienceSize(
    campaignId: string,
  ): Promise<{ estimated: number; strategy: string }> {
    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const query =
      await this.segmentQueryBuilder.analyzeSegmentationStrategy(campaign);

    let estimated = 0;

    if (query.type === 'segment' && query.segmentId) {
      const rows = await this.campaignContactRepository.manager.query(
        `SELECT COUNT(DISTINCT cpa.contact_id)::int AS total
         FROM computed_property_assignments_v2 cpa
         WHERE cpa.computed_property_id = $1
           AND cpa.type = $2
           AND cpa.segment_value = $3`,
        [query.segmentId, 'segment', true],
      );
      estimated = Number(rows?.[0]?.total || 0);
    } else {
      const result = await this.segmentQueryBuilder.executeAudienceQuery(
        campaign,
        query,
        0,
      );
      estimated = result.total;
    }

    return {
      estimated,
      strategy: query.type,
    };
  }

  /**
   * Assign batch sequences to campaign contacts for cursor-based pagination
   */
  async assignBatchSequences(
    campaignId: string,
    batchSize: number = 1000,
  ): Promise<{ batches: number }> {
    this.logger.log(
      `Assigning batch sequences for campaign ${campaignId} with batch size ${batchSize}`,
    );

    const campaignContacts = await this.campaignContactRepository.find({
      where: {
        campaignId,
      },
      order: {
        createdAt: 'ASC',
        id: 'ASC',
      },
    });

    let batchNumber = 1;
    for (let i = 0; i < campaignContacts.length; i++) {
      if (i > 0 && i % batchSize === 0) {
        batchNumber++;
      }

      campaignContacts[i].batchSequence = batchNumber;
    }

    const chunkSize = 1000;
    for (let i = 0; i < campaignContacts.length; i += chunkSize) {
      const chunk = campaignContacts.slice(i, i + chunkSize);
      await this.campaignContactRepository.save(chunk);
    }

    this.logger.log(
      `Assigned ${batchNumber} batches for campaign ${campaignId}`,
    );

    return { batches: batchNumber };
  }

  /**
   * Get a specific batch of contacts for processing. Returns CampaignContact
   * rows only — the contact payload itself must be hydrated by callers via
   * the CRM client.
   */
  async getCampaignBatch(
    campaignId: string,
    batchSequence: number,
    batchSize: number = 1000,
  ): Promise<CampaignContact[]> {
    this.logger.debug(
      `Fetching batch ${batchSequence} for campaign ${campaignId}`,
    );

    const campaignContacts = await this.campaignContactRepository.find({
      where: {
        campaignId,
        batchSequence,
      },
      order: {
        createdAt: 'ASC',
        id: 'ASC',
      },
      take: batchSize,
    });

    return campaignContacts;
  }

  /**
   * Mark contacts as sent after successful message delivery
   */
  async markContactsAsSent(
    campaignId: string,
    contactIds: string[],
  ): Promise<{ updated: number }> {
    if (contactIds.length === 0) {
      return { updated: 0 };
    }

    this.logger.debug(
      `Marking ${contactIds.length} contacts as sent for campaign ${campaignId}`,
    );

    const result = await this.campaignContactRepository
      .createQueryBuilder()
      .update(CampaignContact)
      .set({
        status: CampaignContactStatus.SENT,
        sentAt: new Date(),
      })
      .where('campaignId = :campaignId', { campaignId })
      .andWhere('contactId IN (:...contactIds)', { contactIds })
      .execute();

    this.logger.debug(
      `Updated ${result.affected || 0} contacts to sent status for campaign ${campaignId}`,
    );

    return { updated: result.affected || 0 };
  }
}
