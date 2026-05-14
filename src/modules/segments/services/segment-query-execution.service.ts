import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { Segment } from '../entities/segment.entity';
import { DeletedContactsCacheService } from './deleted-contacts-cache.service';
import { SegmentMetricsService } from '../metrics/segment-metrics.service';
import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface StateSubQuery {
  stateId: string;
  condition: string;
  argMaxValue?: string;
  uniqValue?: string;
  eventTimeExpression?: string;
  recordMessageId: boolean;
  joinPriorStateValue: boolean;
  type: 'segment' | 'contact_property';
  computedPropertyId: string;
  useCountQuery?: boolean;
  timesOperator?: string;
  expectedTimes?: number;
  validationInfo?: {
    operator: string;
    value: string;
    extractPath: string;
  };
}

@Injectable()
export class SegmentQueryExecutionService {
  private readonly logger = new CustomLoggerService(
    SegmentQueryExecutionService.name,
  );

  constructor(
    private readonly clickHouseService: ClickHouseService,
    private readonly deletedContactsCache: DeletedContactsCacheService,
    private readonly metrics: SegmentMetricsService,
    private readonly queryBuilder: SegmentClickHouseQueryBuilderService,
  ) {}

  async executeStateComputation(
    segment: Segment,
    subQueryData: StateSubQuery[],
    now: number,
  ): Promise<void> {
    const nowSeconds = now / 1000;

    const hasTimeWindows = this.segmentHasTimeWindows(segment.definition);
    const shouldUseIncrementalProcessing =
      segment.lastComputedAt && !hasTimeWindows;
    const lastComputedAt =
      shouldUseIncrementalProcessing && segment.lastComputedAt
        ? segment.lastComputedAt.getTime() / 1000
        : 0;

    if (hasTimeWindows) {
      this.logger.debug(
        `Segment ${segment.id} has time windows - disabling incremental processing to ensure all events within time window are processed`,
      );
    } else if (segment.lastComputedAt) {
      this.logger.debug(
        `Segment ${segment.id} using incremental processing from ${new Date(segment.lastComputedAt).toISOString()}`,
      );
    }

    for (const subQuery of subQueryData) {
      const query =
        subQuery.useCountQuery &&
        subQuery.timesOperator &&
        subQuery.expectedTimes !== undefined
          ? `
            INSERT INTO evo_campaign.computed_property_state_v2
            SELECT
              type,
              computed_property_id,
              state_id,
              contact_or_anonymous_id,
              argMaxState(
                CASE WHEN event_count ${this.queryBuilder.getClickHouseOperator(subQuery.timesOperator)} ${subQuery.expectedTimes}
                     THEN 'true'
                     ELSE 'false'
                END,
                max_occurred_at
              ) as last_value,
              uniqState(toString(event_count)) as unique_count,
              max(max_occurred_at) as truncated_event_time,
              groupArrayState('') as grouped_message_id,
              toDateTime64(${nowSeconds}, 3) as computed_at
            FROM (
              SELECT
                '${subQuery.type}' as type,
                '${subQuery.computedPropertyId}' as computed_property_id,
                '${subQuery.stateId}' as state_id,
                ce.contact_or_anonymous_id,
                count(*) as event_count,
                max(ce.occurred_at) as max_occurred_at
              FROM evo_campaign.contact_events ce
              WHERE
                processing_time <= toDateTime64(${nowSeconds}, 3)
                ${lastComputedAt > 0 ? `AND processing_time > toDateTime64(${lastComputedAt}, 3)` : '-- Primeira execução: processar todos os eventos históricos'}
                AND (${subQuery.condition})
              GROUP BY
                ce.contact_or_anonymous_id
            ) grouped_data
            GROUP BY
              type,
              computed_property_id,
              state_id,
              contact_or_anonymous_id
          `
          : `
            INSERT INTO evo_campaign.computed_property_state_v2
            SELECT
              '${subQuery.type}' as type,
              '${subQuery.computedPropertyId}' as computed_property_id,
              '${subQuery.stateId}' as state_id,
              ce.contact_or_anonymous_id,
              ${this.generateArgMaxValidation(subQuery)} as last_value,
              uniqState(ifNull(toString(${subQuery.uniqValue ?? "''"}), '')) as unique_count,
              max(${subQuery.eventTimeExpression ?? "toDateTime64('0000-00-00 00:00:00', 3)"}) as truncated_event_time,
              groupArrayState(ifNull(toString(${subQuery.recordMessageId ? 'ce.message_id' : "''"}), '')) as grouped_message_id,
              toDateTime64(${nowSeconds}, 3) as computed_at
            FROM evo_campaign.contact_events ce
            WHERE
              processing_time <= toDateTime64(${nowSeconds}, 3)
              ${lastComputedAt > 0 ? `AND processing_time > toDateTime64(${lastComputedAt}, 3)` : '-- Primeira execução: processar todos os eventos históricos'}
              AND (${subQuery.condition})
            GROUP BY
              ce.contact_or_anonymous_id
          `;

      const optimizedQuery =
        await this.optimizeQueryWithDeletedContactsCache(query);

      this.logger.debug(
        `Executing optimized query for state ${subQuery.stateId}:\n${optimizedQuery}`,
      );

      await this.clickHouseService.query({ query: optimizedQuery });

      this.logger.debug(
        `Computed state ${subQuery.stateId} for segment ${segment.id}`,
      );

      const verifyQuery = `SELECT count(*) as total FROM evo_campaign.computed_property_state_v2 WHERE state_id = '${subQuery.stateId}'`;
      const stateCount = await this.clickHouseService.query({
        query: verifyQuery,
      });

      this.logger.debug(
        `Inserted ${stateCount[0]?.total || 0} state records for state ${subQuery.stateId}`,
      );
    }
  }

  private async optimizeQueryWithDeletedContactsCache(
    query: string,
  ): Promise<string> {
    this.metrics.recordSegmentComputationAttempt({
      operation: 'deleted_contacts_cache_lookup',
    });

    const deletedContacts = await this.deletedContactsCache.getDeletedContacts();

    if (deletedContacts.size > 0) {
      this.metrics.recordCacheHit();
    } else {
      this.metrics.recordCacheMiss();
    }

    if (deletedContacts.size === 0) {
      return query.replace(
        /WHEN contact_or_anonymous_id IN \([^)]*SELECT[^)]*contact_deleted[^)]*\) THEN '[^']*'/g,
        `WHEN 1=0 THEN 'false'`,
      );
    }

    const deletedContactsArray = Array.from(deletedContacts).map(
      (id) => `'${id}'`,
    );
    const deletedContactsList = deletedContactsArray.join(',');

    const optimizedQuery = query.replace(
      /WHEN contact_or_anonymous_id IN \([^)]*SELECT[^)]*contact_deleted[^)]*\) THEN '[^']*'/g,
      `WHEN contact_or_anonymous_id IN (${deletedContactsList}) THEN 'false'`,
    );

    this.logger.debug(
      `Optimized query: replaced nested subqueries with ${deletedContacts.size} cached deleted contacts`,
    );

    return optimizedQuery;
  }

  private generateArgMaxValidation(subQuery: StateSubQuery): string {
    return this.queryBuilder.generateArgMaxValidation(subQuery);
  }

  segmentHasTimeWindows(definition: any): boolean {
    if (!definition?.nodes) {
      return false;
    }

    const checkNodeForTimeWindow = (node: any): boolean => {
      if (!node) return false;

      if (node.withinSeconds && node.withinSeconds > 0) {
        return true;
      }

      if (node.children && Array.isArray(node.children)) {
        for (const childId of node.children) {
          const childNode = definition.nodes.find((n: any) => n.id === childId);
          if (childNode && checkNodeForTimeWindow(childNode)) {
            return true;
          }
        }
      }

      return false;
    };

    if (definition.entryNode) {
      return checkNodeForTimeWindow(definition.entryNode);
    }

    for (const node of definition.nodes) {
      if (checkNodeForTimeWindow(node)) {
        return true;
      }
    }

    return false;
  }
}
