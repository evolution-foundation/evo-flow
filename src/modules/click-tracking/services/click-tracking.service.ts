import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ShortLink } from '../entities/short-link.entity';
import { LinkParameter } from '../entities/link-parameter.entity';
import { CreateShortLinkDto, UpdateShortLinkDto, BulkCreateLinksDto } from '../dto';
import { UrlShortenerService } from './url-shortener.service';
import { LinkCacheService } from 'src/modules/cache/services/link-cache.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { ClickHouseService } from 'src/modules/processing/clickhouse/clickhouse.service';
import { CustomDomainsService } from './custom-domains.service';

/**
 * Click Tracking Service
 * Handles CRUD operations for short links and parameters
 */
@Injectable()
export class ClickTrackingService {
  private readonly logger = new CustomLoggerService(
    ClickTrackingService.name,
  );

  constructor(
    @InjectRepository(ShortLink)
    private readonly shortLinkRepository: Repository<ShortLink>,
    @InjectRepository(LinkParameter)
    private readonly linkParameterRepository: Repository<LinkParameter>,
    private readonly urlShortenerService: UrlShortenerService,
    private readonly linkCacheService: LinkCacheService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clickHouseService: ClickHouseService,
    private readonly customDomainsService: CustomDomainsService,
  ) {}

  /**
   * Create a new short link
   * Supports both default short codes and custom domain slugs
   */
  async create(dto: CreateShortLinkDto): Promise<ShortLink> {
    try {
      // Validate custom domain if provided
      if (dto.customDomainId) {
        const customDomain = await this.customDomainsService.findById(
          dto.customDomainId,
        );

        if (!customDomain.isVerified) {
          throw new BadRequestException(
            'Custom domain must be verified before creating links',
          );
        }

        // Check slug uniqueness within the custom domain
        if (dto.customSlug !== undefined && dto.customSlug !== null) {
          if (dto.customSlug.length > 0) {
            // Validate slug format
            if (!/^[a-zA-Z0-9-_]+$/.test(dto.customSlug)) {
              throw new BadRequestException(
                'Custom slug can only contain letters, numbers, hyphens, and underscores',
              );
            }
          }
        } else {
          // If no slug provided, use empty string
          dto.customSlug = '';
        }

        // Check slug uniqueness within the custom domain
        const existingLink = await this.shortLinkRepository.findOne({
          where: {
            customDomainId: dto.customDomainId,
            customSlug: dto.customSlug,
          },
        });

        if (existingLink) {
          throw new ConflictException(
            `Slug "${dto.customSlug}" is already in use for this custom domain`,
          );
        }
      }

      // Generate short code (always generated for tracking purposes)
      const shortCode = await this.urlShortenerService.generateShortCode(
        dto.customShortCode,
      );

      // Create short link entity
      const shortLink = this.shortLinkRepository.create({
        shortCode,
        originalUrl: dto.originalUrl,
        campaignId: dto.campaignId,
        journeyId: dto.journeyId,
        contactId: dto.contactId,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        clickCount: 0,
        customDomainId: dto.customDomainId,
        customSlug: dto.customSlug,
      });

      // Save short link
      const savedLink = await this.shortLinkRepository.save(shortLink);

      // Create parameters if provided
      if (dto.parameters && dto.parameters.length > 0) {
        const parameters = dto.parameters.map((param) =>
          this.linkParameterRepository.create({
            shortLinkId: savedLink.id,
            key: param.key,
            value: param.value,
            isUtm: param.isUtm || false,
          }),
        );
        await this.linkParameterRepository.save(parameters);
        savedLink.parameters = parameters;
      }

      // Build short URL based on custom domain or default
      if (dto.customDomainId) {
        // Get custom domain to build URL
        const customDomain = await this.customDomainsService.findById(
          dto.customDomainId,
        );

        // Build URL with or without slug
        if (dto.customSlug) {
          savedLink.shortUrl = `https://${customDomain.domain}/${dto.customSlug}`;
        } else {
          // Empty slug - just use the domain root
          savedLink.shortUrl = `https://${customDomain.domain}/`;
        }

        this.logger.log(
          `Created custom domain link: ${savedLink.shortUrl} (short code: ${shortCode})`,
        );
      } else {
        // Default short URL
        savedLink.shortUrl = this.urlShortenerService.buildShortUrl(shortCode);

        this.logger.log(`Created short link ${shortCode}`);
      }

      // Cache the link (only if using shortCode, custom domain links are not cached)
      if (!dto.customDomainId) {
        await this.linkCacheService.set(savedLink);
      }

      // Emit event
      this.eventEmitter.emit('shortlink.created', {
        id: savedLink.id,
        customDomainId: dto.customDomainId,
      });

      return savedLink;
    } catch (error) {
      this.logger.error(
        `Error creating short link: ${error.message}`,
        error.stack,
      );

      if (error.message.includes('already in use')) {
        throw new ConflictException(error.message);
      }

      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      throw new BadRequestException(`Failed to create short link: ${error.message}`);
    }
  }

  /**
   * Bulk create multiple short links
   */
  async bulkCreate(dto: BulkCreateLinksDto): Promise<ShortLink[]> {
    const results: ShortLink[] = [];
    const errors: Array<{ dto: CreateShortLinkDto; error: string }> = [];

    for (const linkDto of dto.links) {
      try {
        const link = await this.create(linkDto);
        results.push(link);
      } catch (error) {
        errors.push({
          dto: linkDto,
          error: error.message,
        });
        this.logger.warn(
          `Failed to create link for URL ${linkDto.originalUrl}: ${error.message}`,
        );
      }
    }

    if (errors.length > 0) {
      this.logger.warn(
        `Bulk create completed with ${errors.length} errors out of ${dto.links.length} links`,
      );
    }

    return results;
  }

  /**
   * Find short link by ID
   */
  async findById(id: string): Promise<ShortLink> {
    // Try cache first
    const cached = await this.linkCacheService.get(id);
    if (cached) {
      // Convert cached entity back to full entity
      return this.cachedToEntity(cached);
    }

    // Fallback to database
    const link = await this.shortLinkRepository.findOne({
      where: { id },
      relations: ['parameters'],
    });

    if (!link) {
      throw new NotFoundException(`Short link ${id} not found`);
    }

    // Cache for future requests
    await this.linkCacheService.set(link);

    return link;
  }

  /**
   * Find short link by short code
   */
  async findByShortCode(shortCode: string): Promise<ShortLink> {
    // Try cache first
    const cached = await this.linkCacheService.getByShortCode(shortCode);

    if (cached) {
      return this.cachedToEntity(cached);
    }

    // Fallback to database
    const link = await this.shortLinkRepository.findOne({
      where: { shortCode },
      relations: ['parameters'],
    });

    if (!link) {
      throw new NotFoundException(`Short link ${shortCode} not found`);
    }

    return link;
  }

  /**
   * List all short links
   * Fetches click counts in real-time from ClickHouse
   */
  async findAll(options?: {
    campaignId?: string;
    journeyId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ links: ShortLink[]; total: number }> {
    const query = this.shortLinkRepository
      .createQueryBuilder('link')
      .leftJoinAndSelect('link.parameters', 'parameters')
      .leftJoinAndSelect('link.customDomain', 'customDomain');

    // Apply filters
    if (options?.campaignId) {
      query.andWhere('link.campaignId = :campaignId', {
        campaignId: options.campaignId,
      });
    }

    if (options?.journeyId) {
      query.andWhere('link.journeyId = :journeyId', {
        journeyId: options.journeyId,
      });
    }

    if (options?.isActive !== undefined) {
      query.andWhere('link.isActive = :isActive', {
        isActive: options.isActive,
      });
    }

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    if (options?.limit) {
      query.take(options.limit);
    }

    if (options?.offset) {
      query.skip(options.offset);
    }

    // Order by most recent
    query.orderBy('link.createdAt', 'DESC');

    const links = await query.getMany();

    // Get click counts from ClickHouse in real-time
    try {
      const qb = this.clickHouseService.createQueryBuilder();
      qb.addQueryPart('SELECT');
      qb.addQueryPart('JSONExtractString(properties, \'short_link_id\') as short_link_id,');
      qb.addQueryPart('COUNT(*) as click_count,');
      qb.addQueryPart('COUNT(DISTINCT contact_id) as unique_click_count');
      qb.addQueryPart('FROM contact_events');
      qb.addQueryPart(`WHERE event_name = 'link_clicked'`);
      qb.addQueryPart('GROUP BY short_link_id');

      const { query: clickQuery, parameters } = qb.build();

      const clickHouseResults = await this.clickHouseService.query<{
        short_link_id: string;
        click_count: number;
        unique_click_count: number;
      }>({
        query: clickQuery,
        parameters,
      });

      // Create a map of link_id -> counts
      const clickCountsMap = new Map<string, { clickCount: number; uniqueClickCount: number }>();
      for (const result of clickHouseResults) {
        clickCountsMap.set(result.short_link_id, {
          clickCount: result.click_count,
          uniqueClickCount: result.unique_click_count,
        });
      }

      // Update links with real-time counts from ClickHouse
      for (const link of links) {
        const counts = clickCountsMap.get(link.id);
        if (counts) {
          link.clickCount = counts.clickCount;
          link.uniqueClickCount = counts.uniqueClickCount;
        }
        // Build short URL based on custom domain or default
        if (link.customDomain) {
          if (link.customSlug) {
            link.shortUrl = `https://${link.customDomain.domain}/${link.customSlug}`;
          } else {
            link.shortUrl = `https://${link.customDomain.domain}/`;
          }
        } else {
          link.shortUrl = this.urlShortenerService.buildShortUrl(link.shortCode);
        }
      }

      this.logger.log(
        `Loaded ${links.length} links with real-time click counts from ClickHouse`,
      );
    } catch (error) {
      this.logger.error(
        `Error fetching click counts from ClickHouse: ${error.message}`,
        error.stack,
      );
      // Fallback: just add short URLs without updating counts
      for (const link of links) {
        if (link.customDomain) {
          if (link.customSlug) {
            link.shortUrl = `https://${link.customDomain.domain}/${link.customSlug}`;
          } else {
            link.shortUrl = `https://${link.customDomain.domain}/`;
          }
        } else {
          link.shortUrl = this.urlShortenerService.buildShortUrl(link.shortCode);
        }
      }
    }

    return { links, total };
  }

  /**
   * Update short link
   */
  async update(id: string, dto: UpdateShortLinkDto): Promise<ShortLink> {
    const link = await this.findById(id);

    // Update basic fields
    if (dto.originalUrl !== undefined) {
      link.originalUrl = dto.originalUrl;
    }

    if (dto.campaignId !== undefined) {
      link.campaignId = dto.campaignId;
    }

    if (dto.journeyId !== undefined) {
      link.journeyId = dto.journeyId;
    }

    if (dto.contactId !== undefined) {
      link.contactId = dto.contactId;
    }

    if (dto.isActive !== undefined) {
      link.isActive = dto.isActive;
    }

    if (dto.expiresAt !== undefined) {
      link.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    }

    // Update parameters if provided
    if (dto.parameters) {
      // Delete existing parameters
      await this.linkParameterRepository.delete({ shortLinkId: id });

      // Create new parameters
      const parameters = dto.parameters.map((param) =>
        this.linkParameterRepository.create({
          shortLinkId: id,
          key: param.key,
          value: param.value,
          isUtm: param.isUtm || false,
        }),
      );
      await this.linkParameterRepository.save(parameters);
      link.parameters = parameters;
    }

    // Save changes
    const updated = await this.shortLinkRepository.save(link);

    // Invalidate cache
    await this.linkCacheService.invalidate(id);

    // Emit event
    this.eventEmitter.emit('shortlink.updated', { id });

    this.logger.log(`Updated short link ${id}`);

    return updated;
  }

  /**
   * Delete short link
   */
  async delete(id: string): Promise<void> {
    const link = await this.findById(id);

    // Soft delete or hard delete based on preference
    await this.shortLinkRepository.remove(link);

    // Invalidate cache
    await this.linkCacheService.invalidate(id);

    // Emit event
    this.eventEmitter.emit('shortlink.deleted', { id });

    this.logger.log(`Deleted short link ${id}`);
  }

  /**
   * Update click count from ClickHouse to database (periodic sync)
   * Syncs click counts from ClickHouse analytics data to PostgreSQL
   */
  async syncClickCounts(): Promise<number> {
    try {
      this.logger.log(`Starting click count sync from ClickHouse`);

      // Get all links from PostgreSQL
      const { links } = await this.findAll({ limit: 1000 });
      let synced = 0;

      this.logger.log(`Found ${links.length} links to sync from ClickHouse`);

      // Query ClickHouse for click counts grouped by short_link_id
      const qb = this.clickHouseService.createQueryBuilder();
      qb.addQueryPart('SELECT');
      qb.addQueryPart('JSONExtractString(properties, \'short_link_id\') as short_link_id,');
      qb.addQueryPart('JSONExtractString(properties, \'short_code\') as short_code,');
      qb.addQueryPart('COUNT(*) as click_count,');
      qb.addQueryPart('COUNT(DISTINCT contact_id) as unique_click_count');
      qb.addQueryPart('FROM contact_events');
      qb.addQueryPart(`WHERE event_name = 'link_clicked'`);
      qb.addQueryPart('GROUP BY short_link_id, short_code');

      const { query, parameters } = qb.build();

      this.logger.log(`Querying ClickHouse: ${query}`);

      const clickHouseResults = await this.clickHouseService.query<{
        short_link_id: string;
        short_code: string;
        click_count: number;
        unique_click_count: number;
      }>({
        query,
        parameters,
      });

      this.logger.log(
        `ClickHouse returned ${clickHouseResults.length} links with clicks`,
      );

      // Create a map of short_link_id -> counts
      const clickCountsMap = new Map<string, { clickCount: number; uniqueClickCount: number }>();
      for (const result of clickHouseResults) {
        clickCountsMap.set(result.short_link_id, {
          clickCount: result.click_count,
          uniqueClickCount: result.unique_click_count,
        });
        this.logger.log(
          `  ${result.short_code} (${result.short_link_id}): ${result.click_count} clicks, ${result.unique_click_count} unique`,
        );
      }

      // Update PostgreSQL with ClickHouse counts
      for (const link of links) {
        const clickHouseCounts = clickCountsMap.get(link.id);

        if (clickHouseCounts) {
          const { clickCount, uniqueClickCount } = clickHouseCounts;

          this.logger.log(
            `Link ${link.shortCode}: DB=${link.clickCount}/${link.uniqueClickCount}, ClickHouse=${clickCount}/${uniqueClickCount}`,
          );

          if (clickCount !== link.clickCount || uniqueClickCount !== link.uniqueClickCount) {
            await this.shortLinkRepository.update(link.id, {
              clickCount,
              uniqueClickCount,
            });
            synced++;
            this.logger.log(
              `Synced ${link.shortCode}: ${link.clickCount}/${link.uniqueClickCount} -> ${clickCount}/${uniqueClickCount}`,
            );
          }
        } else {
          this.logger.log(
            `Link ${link.shortCode}: No clicks in ClickHouse (DB=${link.clickCount})`,
          );
        }
      }

      this.logger.log(`Synced ${synced} links from ClickHouse to PostgreSQL`);

      return synced;
    } catch (error) {
      this.logger.error(
        `Error syncing click counts from ClickHouse: ${error.message}`,
        error.stack,
      );
      return 0;
    }
  }

  /**
   * Get link statistics
   */
  async getStats(): Promise<{
    totalLinks: number;
    activeLinks: number;
    totalClicks: number;
    topLinks: Array<{ shortCode: string; clickCount: number }>;
  }> {
    const [totalLinks, activeLinks] = await Promise.all([
      this.shortLinkRepository.count(),
      this.shortLinkRepository.count({ where: { isActive: true } }),
    ]);

    const clickResult = await this.shortLinkRepository
      .createQueryBuilder('link')
      .select('SUM(link.clickCount)', 'totalClicks')
      .getRawOne();

    const topLinks = await this.shortLinkRepository
      .createQueryBuilder('link')
      .select(['link.shortCode', 'link.clickCount'])
      .orderBy('link.clickCount', 'DESC')
      .limit(10)
      .getMany();

    return {
      totalLinks,
      activeLinks,
      totalClicks: parseInt(clickResult?.totalClicks || '0', 10),
      topLinks: topLinks.map((l) => ({
        shortCode: l.shortCode,
        clickCount: l.clickCount,
      })),
    };
  }

  // Helper method to convert cached entity to full entity
  private cachedToEntity(cached: any): ShortLink {
    const link = new ShortLink();
    Object.assign(link, cached);
    return link;
  }
}
