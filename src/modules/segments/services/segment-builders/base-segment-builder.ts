import { Injectable } from '@nestjs/common';
import {
  SegmentNode,
  SegmentQueryResult,
  BaseSegmentBuilderConfig,
} from '../../types/segment-computation.types';
import { ContactExclusionQueries } from '../../queries/contact-exclusion-queries';
import { ClickHouseService } from '../../../processing/clickhouse/clickhouse.service';

@Injectable()
export abstract class BaseSegmentBuilder {
  constructor(
    protected readonly clickHouseService: ClickHouseService,
    protected readonly config: BaseSegmentBuilderConfig,
  ) {}

  /**
   * Abstract method that each builder must implement
   */
  abstract buildQuery(node: SegmentNode): Promise<SegmentQueryResult>;

  /**
   * Executes a ClickHouse query and returns contact IDs
   */
  protected async executeQuery(query: string): Promise<string[]> {
    try {
      const result = await this.clickHouseService.query({ query });
      return result.map((row: any) => row.contact_id);
    } catch (error) {
      console.error('Error executing segment query:', error);
      throw error;
    }
  }

  /**
   * Adds contact exclusion clauses to a query
   */
  protected addContactExclusions(
    baseQuery: string,
    contactIdAlias: string = 'contact_id',
  ): string {
    if (!this.config.exclusionOptions.excludeDeleted) {
      return baseQuery;
    }

    const exclusionClause = ContactExclusionQueries.getDeletedContactExclusion(
      contactIdAlias,
    );

    // Add the exclusion to the WHERE clause
    if (baseQuery.toLowerCase().includes(' where ')) {
      return baseQuery.replace(/(\s+WHERE\s+)/i, `$1${exclusionClause} AND `);
    } else {
      return `${baseQuery} WHERE ${exclusionClause}`;
    }
  }

  /**
   * Helper to build basic contact query with exclusions
   */
  protected buildBaseContactQuery(): string {
    return `
      SELECT DISTINCT contact_id
      FROM evo_campaign.contact_events
    `;
  }

  /**
   * Logs query execution for debugging
   */
  protected logQuery(query: string, nodeType: string): void {
    console.log(
      `[${nodeType}] Executing query for segment ${this.config.segmentId}:`,
    );
    console.log(query);
  }

  /**
   * Validates node structure
   */
  protected validateNode(node: SegmentNode, requiredFields: string[]): void {
    for (const field of requiredFields) {
      if (!node[field]) {
        throw new Error(
          `Missing required field '${field}' in ${node.type} node`,
        );
      }
    }
  }
}
