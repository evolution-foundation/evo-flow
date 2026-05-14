import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import {
  SearchEventsDto,
  EventSearchResponseDto,
  EventSearchResultDto,
} from '../dto/search-events.dto';

@Injectable()
export class EventSearchService {
  private readonly logger = new CustomLoggerService(EventSearchService.name);

  constructor(private readonly clickhouseService: ClickHouseService) {}

  /**
   * Search events with flexible filters
   */
  async searchEvents(query: SearchEventsDto): Promise<EventSearchResponseDto> {
    const startTime = Date.now();

    try {
      this.logger.debug('Searching events with filters', { query });

      // Validate required filters
      this.validateSearchQuery(query);

      // Choose data source
      const source = this.determineDataSource(query);

      // Execute search based on source
      let result: { events: EventSearchResultDto[]; total: number };

      if (source === 'clickhouse') {
        result = await this.searchFromClickhouse(query);
      } else {
        result = await this.searchFromPostgres(query);
      }

      // Build response
      const searchTime = Date.now() - startTime;
      const totalPages = Math.ceil(result.total / (query.limit || 20));

      return {
        events: result.events,
        pagination: {
          page: query.page || 1,
          limit: query.limit || 20,
          total: result.total,
          totalPages,
          hasNext: (query.page || 1) < totalPages,
          hasPrev: (query.page || 1) > 1,
        },
        meta: {
          searchTime,
          source,
          filters: this.getActiveFilters(query),
        },
      };
    } catch (error) {
      this.logger.error(
        `Error searching events: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Search events from ClickHouse (historical data)
   */
  private async searchFromClickhouse(
    query: SearchEventsDto,
  ): Promise<{ events: EventSearchResultDto[]; total: number }> {
    const queryBuilder = this.clickhouseService.createQueryBuilder();

    // Build WHERE conditions
    const conditions: string[] = [];

    // (Account filter dropped: single-account)

    // Contact ID filter
    if (query.contactId) {
      conditions.push(
        `contact_id = ${queryBuilder.addParameter(query.contactId)}`,
      );
    }

    // Event type filters
    if (query.eventType) {
      conditions.push(
        `event_type = ${queryBuilder.addParameter(query.eventType)}`,
      );
    } else if (query.eventTypes && query.eventTypes.length > 0) {
      const eventTypeParams = query.eventTypes.map((type) =>
        queryBuilder.addParameter(type),
      );
      conditions.push(`event_type IN (${eventTypeParams.join(',')})`);
    }

    // Event name filters
    if (query.eventName) {
      conditions.push(
        `event_name = ${queryBuilder.addParameter(query.eventName)}`,
      );
    } else if (query.eventNames && query.eventNames.length > 0) {
      const eventNameParams = query.eventNames.map((name) =>
        queryBuilder.addParameter(name),
      );
      conditions.push(`event_name IN (${eventNameParams.join(',')})`);
    }

    // Date range filters
    if (query.startDate) {
      const startDateTime = new Date(query.startDate)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
      conditions.push(
        `occurred_at >= ${queryBuilder.addParameter(startDateTime, 'DateTime64(3)')}`,
      );
    }

    if (query.endDate) {
      const endDateTime = new Date(query.endDate)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
      conditions.push(
        `occurred_at <= ${queryBuilder.addParameter(endDateTime, 'DateTime64(3)')}`,
      );
    }

    const whereClause =
      conditions.length > 0 ? conditions.join(' AND ') : '1=1';

    // Get total count
    const countQuery = queryBuilder
      .addQueryPart(
        `SELECT count() as total FROM contact_events WHERE ${whereClause}`,
      )
      .build();

    const countResult = await this.clickhouseService.query({
      query: countQuery.query,
      parameters: countQuery.parameters,
    });
    const total = countResult[0]?.total || 0;

    // Get paginated results
    const pageNumber = query.page || 1;
    const limitNumber = query.limit || 20;
    const offset = (pageNumber - 1) * limitNumber;
    const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Create new query builder for data query
    const dataQueryBuilder = this.clickhouseService.createQueryBuilder();

    // Rebuild conditions for data query
    const dataConditions: string[] = [];

    if (query.contactId) {
      dataConditions.push(
        `contact_id = ${dataQueryBuilder.addParameter(query.contactId)}`,
      );
    }

    if (query.eventType) {
      dataConditions.push(
        `event_type = ${dataQueryBuilder.addParameter(query.eventType)}`,
      );
    } else if (query.eventTypes && query.eventTypes.length > 0) {
      const eventTypeParams = query.eventTypes.map((type) =>
        dataQueryBuilder.addParameter(type),
      );
      dataConditions.push(`event_type IN (${eventTypeParams.join(',')})`);
    }

    if (query.eventName) {
      dataConditions.push(
        `event_name = ${dataQueryBuilder.addParameter(query.eventName)}`,
      );
    } else if (query.eventNames && query.eventNames.length > 0) {
      const eventNameParams = query.eventNames.map((name) =>
        dataQueryBuilder.addParameter(name),
      );
      dataConditions.push(`event_name IN (${eventNameParams.join(',')})`);
    }

    if (query.startDate) {
      const startDateTime = new Date(query.startDate)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
      dataConditions.push(
        `occurred_at >= ${dataQueryBuilder.addParameter(startDateTime, 'DateTime64(3)')}`,
      );
    }

    if (query.endDate) {
      const endDateTime = new Date(query.endDate)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
      dataConditions.push(
        `occurred_at <= ${dataQueryBuilder.addParameter(endDateTime, 'DateTime64(3)')}`,
      );
    }

    const dataWhereClause =
      dataConditions.length > 0 ? dataConditions.join(' AND ') : '1=1';

    const dataQuery = dataQueryBuilder
      .addQueryPart(
        `SELECT
        id,
        event_type,
        event_name,
        contact_id,
        anonymous_id,
        occurred_at,
        properties,
        traits,
        message_raw
      FROM contact_events`,
      )
      .addQueryPart(`WHERE ${dataWhereClause}`)
      .addQueryPart(`ORDER BY occurred_at ${sortOrder}`)
      .addQueryPart(`LIMIT ${limitNumber} OFFSET ${offset}`)
      .build();

    const events = await this.clickhouseService.query({
      query: dataQuery.query,
      parameters: dataQuery.parameters,
    });

    // Transform results
    const transformedEvents: EventSearchResultDto[] = events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      eventName: event.event_name,
      contactId: event.contact_id || undefined,
      anonymousId: event.anonymous_id || undefined,
      occurredAt: new Date(event.occurred_at),
      properties:
        typeof event.properties === 'string'
          ? JSON.parse(event.properties)
          : event.properties || {},
      context:
        typeof event.message_raw === 'string'
          ? JSON.parse(event.message_raw)
          : event.message_raw || {},
      source: 'clickhouse',
    }));

    return { events: transformedEvents, total };
  }

  /**
   * Search events from PostgreSQL (recent data)
   */
  private async searchFromPostgres(
    query: SearchEventsDto,
  ): Promise<{ events: EventSearchResultDto[]; total: number }> {
    // TODO: Implement PostgreSQL search when needed
    // For now, fallback to ClickHouse
    this.logger.warn(
      'PostgreSQL search not implemented, falling back to ClickHouse',
    );
    return this.searchFromClickhouse(query);
  }

  /**
   * Determine which data source to use
   */
  private determineDataSource(
    query: SearchEventsDto,
  ): 'postgres' | 'clickhouse' {
    if (query.source === 'postgres') return 'postgres';
    if (query.source === 'clickhouse') return 'clickhouse';

    // Auto mode: use ClickHouse for historical data, PostgreSQL for recent
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    if (query.startDate && new Date(query.startDate) > fiveMinutesAgo) {
      return 'postgres';
    }

    return 'clickhouse';
  }

  /**
   * Validate search query
   */
  private validateSearchQuery(query: SearchEventsDto): void {
    // Validate date range
    if (query.startDate && query.endDate) {
      const startDate = new Date(query.startDate);
      const endDate = new Date(query.endDate);

      if (startDate > endDate) {
        throw new Error('startDate must be before endDate');
      }
    }

    // Validate arrays
    if (query.eventTypes && query.eventTypes.length > 10) {
      throw new Error('Maximum 10 event types allowed');
    }

    if (query.eventNames && query.eventNames.length > 20) {
      throw new Error('Maximum 20 event names allowed');
    }
  }

  /**
   * Get active filters for metadata
   */
  private getActiveFilters(query: SearchEventsDto): Record<string, any> {
    const filters: Record<string, any> = {};

    if (query.contactId) filters.contactId = query.contactId;
    if (query.eventType) filters.eventType = query.eventType;
    if (query.eventTypes) filters.eventTypes = query.eventTypes;
    if (query.eventName) filters.eventName = query.eventName;
    if (query.eventNames) filters.eventNames = query.eventNames;
    if (query.startDate) filters.startDate = query.startDate;
    if (query.endDate) filters.endDate = query.endDate;

    return filters;
  }
}
