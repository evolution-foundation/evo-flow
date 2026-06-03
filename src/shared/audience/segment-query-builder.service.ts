import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Campaign } from '../../modules/campaigns/entities/campaign.entity';
import { Segment } from '../../modules/segments/entities/segment.entity';
import { Tagging, TaggableType } from '../../modules/labels/entities/tagging.entity';
import { TenantDbContext } from '../../evo-extension-points';
import { ContactsClientService } from '../crm-client/contacts-client.service';
import type { HydratedContact } from '../crm-client/types/contact';

export interface SegmentQuery {
  type: 'segment' | 'sql' | 'tags' | 'all';
  segmentId?: string;
  sqlQuery?: string;
  tags?: string[];
  contactIds?: string[];
}

export interface AudienceQueryResult {
  contactIds: string[];
  total: number;
  query: SegmentQuery;
}

/**
 * Service responsible for building and executing queries to determine campaign audience
 * Bridges campaigns with the segments module
 *
 * Q3 cleanup: this service no longer reads from the local `contacts` table.
 * Audience composition is now split in two phases:
 *  1. Local sources (taggings table, ClickHouse segment SQL, CRM list endpoint)
 *     yield candidate `contact_ids`.
 *  2. Consumers (`AudienceComputationService`, `AudienceValidationService`)
 *     hydrate those ids via `ContactsClientService.findByIds`.
 *
 * `blocked = false` filtering used to live in raw SQL against contacts; it now
 * happens post-fetch in memory on the hydrated DTOs. CRM Rails returns
 * `blocked` on `/api/v1/contacts/{id}` so this filter survives.
 */
@Injectable()
export class SegmentQueryBuilderService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly contactsClient: ContactsClientService,
  ) {}

  private get segmentRepository(): Repository<Segment> {
    return this.db.getRepository(Segment);
  }

  private get taggingRepository(): Repository<Tagging> {
    return this.db.getRepository(Tagging);
  }

  /**
   * Analyze campaign definition and determine the best query strategy
   */
  async analyzeSegmentationStrategy(campaign: Campaign): Promise<SegmentQuery> {
    // Strategy 1: Send to all contacts
    if (campaign.sendToAll) {
      return {
        type: 'all',
      };
    }

    // Strategy 2: Use existing segment from trigger config
    if (campaign.triggerConfig?.segment_id) {
      return {
        type: 'segment',
        segmentId: campaign.triggerConfig.segment_id,
      };
    }

    // Strategy 3: Use existing segment (if steps contain segment reference)
    if (campaign.steps && this.hasSegmentReference(campaign.steps)) {
      const segmentId = this.extractSegmentId(campaign.steps);
      if (segmentId) {
        return {
          type: 'segment',
          segmentId,
        };
      }
    }

    // Strategy 4: Use tags/labels for filtering
    if (campaign.tags && campaign.tags.length > 0) {
      return {
        type: 'tags',
        tags: campaign.tags,
      };
    }

    // Strategy 5: Use raw SQL query (if provided)
    if (campaign.query) {
      return {
        type: 'sql',
        sqlQuery: campaign.query,
      };
    }

    // Default: all contacts
    return {
      type: 'all',
    };
  }

  /**
   * Execute query to get contact IDs based on strategy
   */
  async executeAudienceQuery(
    campaign: Campaign,
    query: SegmentQuery,
    limit?: number,
    offset: number = 0,
  ): Promise<AudienceQueryResult> {
    switch (query.type) {
      case 'all':
        return this.getAllContacts(limit, offset);

      case 'tags':
        return this.getContactsByTags(query.tags!, limit, offset);

      case 'sql':
        return this.getContactsBySQL(query.sqlQuery!, limit, offset);

      case 'segment':
        // This will be handled by AudienceComputationService
        // which integrates with SegmentComputationService
        throw new Error(
          'Segment-based queries should be handled by AudienceComputationService',
        );

      default:
        throw new Error(`Unknown query type: ${query.type}`);
    }
  }

  /**
   * Get all contacts (paginated via CRM list endpoint). The `blocked = false`
   * filter is applied client-side using the `blocked` flag returned by CRM
   * Rails. Pagination uses CRM Rails default order (created_at DESC).
   */
  private async getAllContacts(
    limit?: number,
    offset: number = 0,
  ): Promise<AudienceQueryResult> {
    const all = await this.contactsClient.listAllIds();
    const active = all.filter((c) => !c.blocked).map((c) => c.id);

    const total = active.length;
    const paginated =
      limit !== undefined ? active.slice(offset, offset + limit) : active;

    return {
      contactIds: paginated,
      total,
      query: { type: 'all' },
    };
  }

  /**
   * Get contacts by tags/labels using the local taggings table. The
   * `taggings` table is owned by evo-flow (labels module), not CRM, so this
   * query stays local. Only Contact-type taggings are returned. Blocked-flag
   * filtering is deferred to the hydration step (consumers).
   */
  private async getContactsByTags(
    tags: string[],
    limit?: number,
    offset: number = 0,
  ): Promise<AudienceQueryResult> {
    const baseQb = this.taggingRepository
      .createQueryBuilder('tagging')
      .innerJoin('tagging.tag', 'tag')
      .where('tagging.taggableType = :type', { type: TaggableType.CONTACT })
      .andWhere('tag.name IN (:...tags)', { tags })
      .select('DISTINCT tagging.taggableId', 'id');

    // getRawMany() doesn't honour skip/take cleanly with DISTINCT, so do it in JS.
    const rows = await baseQb.getRawMany();
    const allIds = rows.map((r) => r.id);
    const total = allIds.length;

    const paginated =
      limit !== undefined ? allIds.slice(offset, offset + limit) : allIds;

    return {
      contactIds: paginated,
      total,
      query: { type: 'tags', tags },
    };
  }

  /**
   * Execute custom SQL query to get contact ids. The user-provided SQL must
   * select an `id` column; we surface the result directly without joining
   * `contacts`. Blocked filtering is post-fetch (consumers).
   *
   * SECURITY: validateSQLQuery still enforces SELECT-only / no comments / no
   * DDL. Tables referenced inside the SQL must exist in the evo-flow
   * Postgres (typically `computed_property_assignments_v2` for segment math).
   */
  private async getContactsBySQL(
    sqlQuery: string,
    limit?: number,
    offset: number = 0,
  ): Promise<AudienceQueryResult> {
    this.validateSQLQuery(sqlQuery);

    const countQuery = `SELECT COUNT(*)::int AS total FROM (${sqlQuery}) src`;
    const countResult = await this.segmentRepository.query(countQuery);
    const total = Number(countResult?.[0]?.total || 0);

    const resolvedLimit = limit === undefined ? total || 100000 : limit;
    const pagedQuery = `
      SELECT src.id
      FROM (${sqlQuery}) src
      ORDER BY src.id ASC
      LIMIT $1 OFFSET $2
    `;
    const rows = await this.segmentRepository.query(pagedQuery, [
      resolvedLimit,
      offset,
    ]);
    const paginatedIds = rows.map((r: any) => r.id);

    return {
      contactIds: paginatedIds,
      total,
      query: { type: 'sql', sqlQuery },
    };
  }

  /**
   * Validate SQL query for safety
   * Basic validation to prevent SQL injection
   */
  private validateSQLQuery(sqlQuery: string): void {
    const normalized = sqlQuery.trim();
    const upperQuery = normalized.toUpperCase();

    if (normalized.length === 0) {
      throw new Error('SQL query is empty');
    }

    if (normalized.includes(';')) {
      throw new Error('SQL query cannot contain semicolons');
    }
    if (upperQuery.includes('--') || upperQuery.includes('/*')) {
      throw new Error('SQL query cannot contain SQL comments');
    }

    // Check for dangerous keywords
    const dangerousKeywords = [
      'DROP',
      'DELETE',
      'TRUNCATE',
      'UPDATE',
      'INSERT',
      'ALTER',
      'CREATE',
      'GRANT',
      'REVOKE',
    ];

    for (const keyword of dangerousKeywords) {
      if (upperQuery.includes(keyword)) {
        throw new Error(`SQL query contains forbidden keyword: ${keyword}`);
      }
    }

    // Query must be a SELECT statement
    if (!upperQuery.trim().startsWith('SELECT')) {
      throw new Error('SQL query must be a SELECT statement');
    }

    // Query must expose an ID column to join with contacts.
    if (!/\bSELECT\b[\s\S]*\bID\b/i.test(normalized)) {
      throw new Error('SQL query must select an "id" column');
    }
  }

  /**
   * Check if steps object contains a segment reference
   */
  private hasSegmentReference(steps: any): boolean {
    return this.extractSegmentId(steps) !== null;
  }

  /**
   * Extract segment ID from steps object
   */
  private extractSegmentId(steps: any): string | null {
    if (!steps || typeof steps !== 'object') {
      return null;
    }

    const queue: any[] = [steps];
    const visited = new Set<any>();

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') {
        continue;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (typeof node.segment_id === 'string' && node.segment_id.length > 0) {
        return node.segment_id;
      }
      if (typeof node.segmentId === 'string' && node.segmentId.length > 0) {
        return node.segmentId;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object') {
            queue.push(item);
          }
        }
      } else {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') {
            queue.push(value);
          }
        }
      }
    }

    return null;
  }

  /**
   * Get segment by ID
   */
  async getSegment(segmentId: string): Promise<Segment> {
    const segment = await this.segmentRepository.findOne({
      where: { id: segmentId },
    });

    if (!segment) {
      throw new Error(`Segment ${segmentId} not found`);
    }

    return segment;
  }

  /**
   * Validate that a hydrated contact (CRM DTO -> in-memory shape) has the
   * fields required by the channel type. Operates purely on the in-memory
   * camelCase shape so callers can pass either the `HydratedContact` returned
   * by `mapContactDto` or any compatible object.
   */
  validateContactForChannel(
    contact: HydratedContact,
    channelType: string,
  ): { valid: boolean; reason?: string } {
    switch (channelType) {
      case 'Channel::Email':
        if (!contact.email) {
          return { valid: false, reason: 'Contact has no email address' };
        }
        if (!this.isValidEmail(contact.email)) {
          return { valid: false, reason: 'Contact has invalid email address' };
        }
        break;

      case 'Channel::Whatsapp':
      case 'Channel::Sms':
        if (!contact.phoneNumber) {
          return { valid: false, reason: 'Contact has no phone number' };
        }
        break;

      default:
        return { valid: false, reason: `Unknown channel type: ${channelType}` };
    }

    // Check if contact is blocked
    if (contact.blocked) {
      return { valid: false, reason: 'Contact is blocked' };
    }

    return { valid: true };
  }

  /**
   * Basic email validation
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}
