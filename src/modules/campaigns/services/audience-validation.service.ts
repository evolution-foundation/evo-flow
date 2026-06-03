import { Injectable, Logger } from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { Campaign } from '../entities/campaign.entity';
import { CampaignContact } from '../entities/campaign-contact.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { SegmentQueryBuilderService } from '../../../shared/audience/segment-query-builder.service';
import { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import {
  mapContactDto,
  type HydratedContact,
} from '../../../shared/crm-client/types/contact';

export interface ValidationIssue {
  type:
    | 'blocked'
    | 'missing_field'
    | 'invalid_email'
    | 'invalid_phone'
    | 'duplicate';
  contactId: string;
  message: string;
}

export interface AudienceValidationResult {
  totalContacts: number;
  validContacts: number;
  issues: ValidationIssue[];
  summary: {
    blocked: number;
    missingFields: number;
    invalidEmail: number;
    invalidPhone: number;
    duplicates: number;
  };
  isValid: boolean;
}

/**
 * Service responsible for validating campaign audience quality.
 *
 * Q3 cleanup: contact records no longer live in evo-flow Postgres. Audience
 * IDs come from local sources (campaign_contacts, computed_property_*) and
 * full contact records are hydrated via the CRM client. Validation operates
 * on the in-memory `HydratedContact` shape.
 */
@Injectable()
export class AudienceValidationService {
  private readonly logger = new Logger(AudienceValidationService.name);

  constructor(
    private readonly db: TenantDbContext,
    private readonly segmentQueryBuilder: SegmentQueryBuilderService,
    private readonly contactsClient: ContactsClientService,
  ) {}

  private get campaignRepository(): Repository<Campaign> {
    return this.db.getRepository(Campaign);
  }

  private get campaignContactRepository(): Repository<CampaignContact> {
    return this.db.getRepository(CampaignContact);
  }

  /**
   * Validate entire campaign audience
   */
  async validateAudience(
    campaignId: string,
  ): Promise<AudienceValidationResult> {
    this.logger.log(`Validating audience for campaign ${campaignId}`);

    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const campaignContacts = await this.campaignContactRepository.find({
      where: {
        campaignId,
      },
    });

    const totalContacts = campaignContacts.length;

    if (totalContacts === 0) {
      this.logger.warn(
        `No contacts found for campaign ${campaignId}. Run audience computation first.`,
      );
      return this.emptyResult();
    }

    const contactIds = campaignContacts.map((cc) => cc.contactId);
    const dtos = await this.contactsClient.findByIds(contactIds);
    const contacts = dtos
      .map((dto) => mapContactDto(dto))
      .filter((c): c is HydratedContact => c !== null);

    const contactMap = new Map<string, HydratedContact>();
    contacts.forEach((contact) => {
      contactMap.set(contact.id, contact);
    });

    const issues: ValidationIssue[] = [];
    let validContacts = 0;

    const summary = {
      blocked: 0,
      missingFields: 0,
      invalidEmail: 0,
      invalidPhone: 0,
      duplicates: 0,
    };

    for (const campaignContact of campaignContacts) {
      const contact = contactMap.get(campaignContact.contactId);

      if (!contact) {
        issues.push({
          type: 'missing_field',
          contactId: campaignContact.contactId,
          message: 'Contact not found in CRM',
        });
        summary.missingFields++;
        continue;
      }

      const validation = this.segmentQueryBuilder.validateContactForChannel(
        contact,
        campaign.channelType || '',
      );

      if (!validation.valid) {
        const issueType = this.categorizeValidationIssue(validation.reason);
        issues.push({
          type: issueType,
          contactId: contact.id,
          message: validation.reason || 'Unknown validation error',
        });

        switch (issueType) {
          case 'blocked':
            summary.blocked++;
            break;
          case 'missing_field':
            summary.missingFields++;
            break;
          case 'invalid_email':
            summary.invalidEmail++;
            break;
          case 'invalid_phone':
            summary.invalidPhone++;
            break;
        }
      } else {
        validContacts++;
      }
    }

    const duplicateIssues = this.findDuplicates(contacts, campaign.channelType);
    issues.push(...duplicateIssues);
    summary.duplicates = duplicateIssues.length;

    const isValid = validContacts > 0 && issues.length === 0;

    this.logger.log(
      `Validation completed for campaign ${campaignId}: ${validContacts}/${totalContacts} valid, ${issues.length} issues`,
    );

    return {
      totalContacts,
      validContacts,
      issues,
      summary,
      isValid,
    };
  }

  /**
   * Validate audience before computation (estimate)
   */
  async validateBeforeComputation(
    campaignId: string,
    sampleSize: number = 100,
  ): Promise<AudienceValidationResult> {
    this.logger.log(
      `Pre-validating audience for campaign ${campaignId} with sample size ${sampleSize}`,
    );

    const campaign = await this.campaignRepository.findOne({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const query =
      await this.segmentQueryBuilder.analyzeSegmentationStrategy(campaign);

    let sampleIds: string[] = [];
    let total = 0;

    if (query.type === 'segment' && query.segmentId) {
      // Sample from the segment assignment table directly (no contacts JOIN).
      const sampleRows = await this.campaignContactRepository.manager.query(
        `SELECT DISTINCT cpa.contact_id AS id
         FROM computed_property_assignments_v2 cpa
         WHERE cpa.computed_property_id = $1
           AND cpa.type = $2
           AND cpa.segment_value = $3
         LIMIT $4`,
        [query.segmentId, 'segment', true, sampleSize],
      );
      sampleIds = sampleRows.map((r: any) => r.id);

      const countRows = await this.campaignContactRepository.manager.query(
        `SELECT COUNT(DISTINCT cpa.contact_id)::int AS total
         FROM computed_property_assignments_v2 cpa
         WHERE cpa.computed_property_id = $1
           AND cpa.type = $2
           AND cpa.segment_value = $3`,
        [query.segmentId, 'segment', true],
      );
      total = Number(countRows?.[0]?.total || 0);
    } else {
      const result = await this.segmentQueryBuilder.executeAudienceQuery(
        campaign,
        query,
        sampleSize,
      );
      sampleIds = result.contactIds;
      total = result.total;
    }

    if (sampleIds.length === 0) {
      return this.emptyResult();
    }

    const dtos = await this.contactsClient.findByIds(sampleIds);
    const contacts = dtos
      .map((dto) => mapContactDto(dto))
      .filter((c): c is HydratedContact => c !== null);

    const issues: ValidationIssue[] = [];
    let validContacts = 0;

    const summary = {
      blocked: 0,
      missingFields: 0,
      invalidEmail: 0,
      invalidPhone: 0,
      duplicates: 0,
    };

    for (const contact of contacts) {
      const validation = this.segmentQueryBuilder.validateContactForChannel(
        contact,
        campaign.channelType || '',
      );

      if (!validation.valid) {
        const issueType = this.categorizeValidationIssue(validation.reason);
        issues.push({
          type: issueType,
          contactId: contact.id,
          message: validation.reason || 'Unknown validation error',
        });

        switch (issueType) {
          case 'blocked':
            summary.blocked++;
            break;
          case 'missing_field':
            summary.missingFields++;
            break;
          case 'invalid_email':
            summary.invalidEmail++;
            break;
          case 'invalid_phone':
            summary.invalidPhone++;
            break;
        }
      } else {
        validContacts++;
      }
    }

    const duplicateIssues = this.findDuplicates(contacts, campaign.channelType);
    issues.push(...duplicateIssues);
    summary.duplicates = duplicateIssues.length;

    const isValid = validContacts > 0;

    this.logger.log(
      `Pre-validation completed for campaign ${campaignId}: ${validContacts}/${contacts.length} valid in sample`,
    );

    return {
      totalContacts: total,
      validContacts,
      issues,
      summary,
      isValid,
    };
  }

  private emptyResult(): AudienceValidationResult {
    return {
      totalContacts: 0,
      validContacts: 0,
      issues: [],
      summary: {
        blocked: 0,
        missingFields: 0,
        invalidEmail: 0,
        invalidPhone: 0,
        duplicates: 0,
      },
      isValid: false,
    };
  }

  /**
   * Find duplicate contacts based on channel type
   */
  private findDuplicates(
    contacts: HydratedContact[],
    channelType?: string,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const seen = new Set<string>();

    for (const contact of contacts) {
      let key: string | null = null;

      if (channelType === 'Channel::Email' && contact.email) {
        key = contact.email.toLowerCase();
      } else if (
        (channelType === 'Channel::Whatsapp' ||
          channelType === 'Channel::Sms') &&
        contact.phoneNumber
      ) {
        key = contact.phoneNumber;
      }

      if (key && seen.has(key)) {
        issues.push({
          type: 'duplicate',
          contactId: contact.id,
          message: `Duplicate ${channelType === 'Channel::Email' ? 'email' : 'phone number'}: ${key}`,
        });
      } else if (key) {
        seen.add(key);
      }
    }

    return issues;
  }

  /**
   * Categorize validation issue type from reason string
   */
  private categorizeValidationIssue(reason?: string): ValidationIssue['type'] {
    if (!reason) {
      return 'missing_field';
    }

    const lowerReason = reason.toLowerCase();

    if (lowerReason.includes('blocked')) {
      return 'blocked';
    }
    if (lowerReason.includes('email')) {
      return 'invalid_email';
    }
    if (lowerReason.includes('phone')) {
      return 'invalid_phone';
    }
    if (lowerReason.includes('no email') || lowerReason.includes('no phone')) {
      return 'missing_field';
    }

    return 'missing_field';
  }

  /**
   * Get validation issues with pagination
   */
  async getValidationIssues(
    campaignId: string,
    issueType?: ValidationIssue['type'],
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ issues: ValidationIssue[]; total: number }> {
    const validation = await this.validateAudience(campaignId);

    let filteredIssues = validation.issues;
    if (issueType) {
      filteredIssues = validation.issues.filter(
        (issue) => issue.type === issueType,
      );
    }

    const paginatedIssues = filteredIssues.slice(offset, offset + limit);

    return {
      issues: paginatedIssues,
      total: filteredIssues.length,
    };
  }

  /**
   * Remove invalid contacts from campaign audience
   */
  async removeInvalidContacts(
    campaignId: string,
  ): Promise<{ removed: number }> {
    this.logger.log(`Removing invalid contacts from campaign ${campaignId}`);

    const validation = await this.validateAudience(campaignId);

    if (validation.issues.length === 0) {
      this.logger.log(`No invalid contacts found for campaign ${campaignId}`);
      return { removed: 0 };
    }

    const invalidContactIds = validation.issues.map((issue) => issue.contactId);

    const result = await this.campaignContactRepository.delete({
      campaignId,
      contactId: In(invalidContactIds),
    });

    this.logger.log(
      `Removed ${result.affected || 0} invalid contacts from campaign ${campaignId}`,
    );

    return { removed: result.affected || 0 };
  }
}
