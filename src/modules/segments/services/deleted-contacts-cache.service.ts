import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class DeletedContactsCacheService {
  private readonly logger = new CustomLoggerService(
    DeletedContactsCacheService.name,
  );
  private readonly CACHE_KEY = 'deleted_contacts';
  private cached: Set<string> | null = null;
  private expiresAt: number = 0;
  private readonly CACHE_TTL = 300000; // 5 minutes

  constructor(private readonly clickhouseService: ClickHouseService) {}

  async getDeletedContacts(): Promise<Set<string>> {
    const now = Date.now();

    if (this.cached && now < this.expiresAt) {
      this.logger.debug('Deleted contacts cache hit');
      return this.cached;
    }

    this.logger.debug('Deleted contacts cache miss, fetching from ClickHouse');

    try {
      const deletedContacts = await this.fetchDeletedContactsFromClickHouse();
      this.cached = deletedContacts;
      this.expiresAt = now + this.CACHE_TTL;
      this.logger.debug(`Cached ${deletedContacts.size} deleted contacts`);
      return deletedContacts;
    } catch (error) {
      this.logger.error('Failed to fetch deleted contacts:', error);
      if (this.cached) {
        this.logger.warn('Using expired cache data due to fetch error');
        return this.cached;
      }
      return new Set<string>();
    }
  }

  private async fetchDeletedContactsFromClickHouse(): Promise<Set<string>> {
    const query = `
      SELECT DISTINCT contact_or_anonymous_id
      FROM contact_events
      WHERE event_name = 'contact_deleted'
      GROUP BY contact_or_anonymous_id
      HAVING argMax(occurred_at, occurred_at) > 0
    `;

    const result = await this.clickhouseService.query({ query });

    const deletedContacts = new Set<string>();
    result.forEach((row: any) => {
      if (row.contact_or_anonymous_id) {
        deletedContacts.add(row.contact_or_anonymous_id);
      }
    });

    return deletedContacts;
  }

  invalidateCache(): void {
    this.cached = null;
    this.expiresAt = 0;
    this.logger.debug('Deleted contacts cache invalidated');
  }

  getCacheStats(): {
    totalEntries: number;
    expiredEntries: number;
    memoryUsage: number;
  } {
    const now = Date.now();
    const expired = this.cached && now >= this.expiresAt ? 1 : 0;
    return {
      totalEntries: this.cached ? 1 : 0,
      expiredEntries: expired,
      memoryUsage: this.cached ? this.cached.size * 36 : 0,
    };
  }
}
