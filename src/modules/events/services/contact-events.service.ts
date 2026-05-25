import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import {
  ContactEventDto,
  ContactEventsResponseDto,
} from '../dto/contact-event-response.dto';
import {
  ContactEventChType,
  ListContactEventsQueryDto,
} from '../dto/list-contact-events-query.dto';
import {
  CursorPayload,
  decodeCursor,
  encodeCursor,
} from '../utils/cursor-codec';

interface ContactEventRow {
  id: string;
  contact_id: string;
  event_type: ContactEventChType;
  event_name: string;
  occurred_at: string;
  properties: string | Record<string, unknown> | null;
  traits: string | Record<string, unknown> | null;
  anonymous_id: string | null;
  message_id: string | null;
}

const toClickHouseDateTime = (iso: string): string =>
  new Date(iso).toISOString().replace('T', ' ').replace('Z', '');

// ClickHouse returns DateTime64(3) in JSONEachRow as a tz-less string like
// `'2026-05-25 10:00:00.123'`. `new Date(str)` would interpret that as local
// time. Force UTC so the cursor round-trip is stable regardless of the CH
// server's TZ configuration.
const rowDateToIsoUtc = (raw: string): string => {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return new Date(raw).toISOString();
  }
  return new Date(`${raw.replace(' ', 'T')}Z`).toISOString();
};

@Injectable()
export class ContactEventsService {
  private readonly logger = new CustomLoggerService(ContactEventsService.name);

  constructor(private readonly clickhouseService: ClickHouseService) {}

  async list(
    contactId: string,
    query: ListContactEventsQueryDto,
  ): Promise<ContactEventsResponseDto> {
    const startTime = Date.now();
    // DTO already enforces @Min(1)/@Max(100) and supplies the 50 default;
    // we trust it as the single source of truth (no second ?? fallback here).
    const limit = query.limit as number;

    const cursor: CursorPayload | null = query.cursor
      ? decodeCursor(query.cursor)
      : null;

    const qb = this.clickhouseService.createQueryBuilder();
    const conditions: string[] = [];

    conditions.push(`contact_id = ${qb.addParameter(contactId)}`);

    if (query.eventType && query.eventType.length > 0) {
      const params = query.eventType.map((t) => qb.addParameter(t));
      conditions.push(`event_type IN (${params.join(',')})`);
    }

    if (query.eventName && query.eventName.length > 0) {
      const params = query.eventName.map((n) => qb.addParameter(n));
      conditions.push(`event_name IN (${params.join(',')})`);
    }

    if (query.channel) {
      conditions.push(
        `JSONExtractString(properties, 'channel') = ${qb.addParameter(query.channel)}`,
      );
    }

    if (query.campaignId) {
      conditions.push(
        `JSONExtractString(properties, 'campaign_id') = ${qb.addParameter(query.campaignId)}`,
      );
    }

    if (query.occurredAfter) {
      conditions.push(
        `occurred_at >= ${qb.addParameter(toClickHouseDateTime(query.occurredAfter), 'DateTime64(3)')}`,
      );
    }

    if (query.occurredBefore) {
      conditions.push(
        `occurred_at <= ${qb.addParameter(toClickHouseDateTime(query.occurredBefore), 'DateTime64(3)')}`,
      );
    }

    if (cursor) {
      const cursorTs = qb.addParameter(
        toClickHouseDateTime(cursor.occurredAt),
        'DateTime64(3)',
      );
      // Schema declares `id UUID`. Binding as :UUID keeps the comparison
      // typed (and avoids implicit-coercion errors on stricter CH versions).
      const cursorId = qb.addParameter(cursor.id, 'UUID');
      conditions.push(
        `(occurred_at < ${cursorTs} OR (occurred_at = ${cursorTs} AND id < ${cursorId}))`,
      );
    }

    const whereClause = conditions.join(' AND ');

    const built = qb
      .addQueryPart(
        `SELECT id, contact_id, event_type, event_name, occurred_at, properties, traits, anonymous_id, message_id FROM contact_events WHERE ${whereClause} ORDER BY occurred_at DESC, id DESC LIMIT ${limit + 1}`,
      )
      .build();

    const rows = await this.clickhouseService.query<ContactEventRow>({
      query: built.query,
      parameters: built.parameters,
    });

    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;

    const events: ContactEventDto[] = pageRows.map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      eventType: row.event_type,
      eventName: row.event_name,
      occurredAt: rowDateToIsoUtc(row.occurred_at),
      properties: this.parseJsonField(row.properties, row.id, 'properties'),
      traits: this.parseJsonField(row.traits, row.id, 'traits'),
      messageId: row.message_id ?? undefined,
      anonymousId: row.anonymous_id ?? undefined,
    }));

    const last = events[events.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
        : null;

    // Per-request log kept at debug to avoid INFO-level noise on a high-volume
    // timeline endpoint. CustomLoggerService.debug is a no-op in this codebase;
    // promote back to log() if you wire up structured-log shipping later.
    this.logger.debug(
      `Listed ${events.length} events for contact (hasNext=${hasNext}) in ${Date.now() - startTime}ms`,
    );

    return {
      events,
      pagination: { nextCursor, hasNext, limit },
    };
  }

  private parseJsonField(
    raw: ContactEventRow['properties'],
    rowId: string,
    field: string,
  ): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      if (raw.length === 0) return {};
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Surface a printable prefix to help locate the writer producing
        // bad JSON without dumping a potentially huge / PII-bearing payload.
        const preview = raw
          .slice(0, 80)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, '?');
        this.logger.warn(
          `Corrupt JSON in contact_events.${field} for row ${rowId} (preview="${preview}"); returning {}`,
        );
        return {};
      }
    }
    return raw;
  }
}
