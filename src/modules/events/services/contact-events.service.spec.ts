import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ClickHouseQueryBuilderImpl,
  ClickHouseService,
} from '../../processing/clickhouse/clickhouse.service';
import { ContactEventsService } from './contact-events.service';
import {
  ContactEventChType,
  ListContactEventsQueryDto,
} from '../dto/list-contact-events-query.dto';
import { encodeCursor } from '../utils/cursor-codec';

interface FakeRow {
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

const makeRow = (i: number, overrides: Partial<FakeRow> = {}): FakeRow => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  contact_id: 'contact-1',
  event_type: 'track',
  event_name: 'message.delivered',
  occurred_at: `2026-05-25 10:${String(59 - i).padStart(2, '0')}:00.000`,
  properties: '{"channel":"whatsapp","campaign_id":"cmp_1"}',
  traits: '{}',
  anonymous_id: null,
  message_id: `msg-${i}`,
  ...overrides,
});

describe('ContactEventsService', () => {
  let service: ContactEventsService;
  let queryMock: jest.Mock;
  let createQueryBuilderMock: jest.Mock;

  beforeEach(async () => {
    queryMock = jest.fn();
    // Real builder instance so we verify SQL the builder actually produces
    createQueryBuilderMock = jest.fn(() => new ClickHouseQueryBuilderImpl());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactEventsService,
        {
          provide: ClickHouseService,
          useValue: {
            createQueryBuilder: createQueryBuilderMock,
            query: queryMock,
          },
        },
      ],
    }).compile();

    service = module.get<ContactEventsService>(ContactEventsService);
  });

  it('happy path: 50 rows returned, hasNext=false, nextCursor=null, LIMIT 51 in SQL', async () => {
    queryMock.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => makeRow(i)),
    );

    const query: ListContactEventsQueryDto = { limit: 50 };
    const result = await service.list('contact-1', query);

    expect(result.events).toHaveLength(50);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.limit).toBe(50);

    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.query).toMatch(/contact_id = \{param_0:String\}/);
    expect(callArgs.query).toMatch(
      /ORDER BY occurred_at DESC, id DESC LIMIT 51/,
    );
    expect(callArgs.parameters).toEqual({ param_0: 'contact-1' });
  });

  it('returns 51 rows from ClickHouse → trims to 50, hasNext=true, nextCursor from 50th (not 51st)', async () => {
    queryMock.mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, i) => makeRow(i)),
    );

    const result = await service.list('contact-1', { limit: 50 });

    expect(result.events).toHaveLength(50);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();

    const last = result.events[49];
    const expected = encodeCursor({ occurredAt: last.occurredAt, id: last.id });
    expect(result.pagination.nextCursor).toBe(expected);

    // 51st row's id (i=50) must not be the cursor
    const ghostId = `00000000-0000-0000-0000-${String(50).padStart(12, '0')}`;
    expect(last.id).not.toBe(ghostId);
  });

  it('applies all filters with AND, including JSONExtractString for channel and campaign_id', async () => {
    queryMock.mockResolvedValueOnce([]);

    const query: ListContactEventsQueryDto = {
      eventType: ['track'],
      eventName: ['message.delivered', 'message.read'],
      channel: 'whatsapp',
      campaignId: 'cmp_1',
      occurredAfter: '2026-04-01T00:00:00Z',
      occurredBefore: '2026-04-30T23:59:59Z',
      limit: 50,
    };

    await service.list('contact-1', query);

    const sql = queryMock.mock.calls[0][0].query as string;
    const params = queryMock.mock.calls[0][0].parameters as Record<
      string,
      unknown
    >;

    expect(sql).toMatch(/contact_id = \{param_0:String\}/);
    expect(sql).toMatch(/event_type IN \(\{param_1:String\}\)/);
    expect(sql).toMatch(
      /event_name IN \(\{param_2:String\},\{param_3:String\}\)/,
    );
    expect(sql).toMatch(
      /JSONExtractString\(properties, 'channel'\) = \{param_4:String\}/,
    );
    expect(sql).toMatch(
      /JSONExtractString\(properties, 'campaign_id'\) = \{param_5:String\}/,
    );
    expect(sql).toMatch(/occurred_at >= \{param_6:DateTime64\(3\)\}/);
    expect(sql).toMatch(/occurred_at <= \{param_7:DateTime64\(3\)\}/);
    // All joined by AND
    expect(sql.split(' AND ').length).toBe(7);

    expect(params).toMatchObject({
      param_0: 'contact-1',
      param_1: 'track',
      param_2: 'message.delivered',
      param_3: 'message.read',
      param_4: 'whatsapp',
      param_5: 'cmp_1',
    });
  });

  it('decoded cursor adds (occurred_at < ? OR (occurred_at = ? AND id < ?)) clause with id bound as UUID', async () => {
    queryMock.mockResolvedValueOnce([]);

    const cursor = encodeCursor({
      occurredAt: '2026-05-25T09:00:00.000Z',
      id: 'a3f1b2c4-5d6e-7f80-91a2-b3c4d5e6f708',
    });

    await service.list('contact-1', { cursor, limit: 50 });

    const sql = queryMock.mock.calls[0][0].query as string;
    expect(sql).toMatch(
      /\(occurred_at < \{param_1:DateTime64\(3\)\} OR \(occurred_at = \{param_1:DateTime64\(3\)\} AND id < \{param_2:UUID\}\)\)/,
    );

    const params = queryMock.mock.calls[0][0].parameters as Record<
      string,
      unknown
    >;
    expect(params.param_2).toBe('a3f1b2c4-5d6e-7f80-91a2-b3c4d5e6f708');
    expect(params.param_1).toBe('2026-05-25 09:00:00.000');
  });

  it('treats ClickHouse occurred_at as UTC even when no TZ suffix is present (F8)', async () => {
    queryMock.mockResolvedValueOnce([
      makeRow(0, { occurred_at: '2026-05-25 10:30:00.000' }),
    ]);

    const result = await service.list('contact-1', { limit: 50 });

    expect(result.events[0].occurredAt).toBe('2026-05-25T10:30:00.000Z');
  });

  it('respects an existing TZ suffix on occurred_at', async () => {
    queryMock.mockResolvedValueOnce([
      makeRow(0, { occurred_at: '2026-05-25T10:30:00.000Z' }),
    ]);

    const result = await service.list('contact-1', { limit: 50 });

    expect(result.events[0].occurredAt).toBe('2026-05-25T10:30:00.000Z');
  });

  it('throws BadRequestException for invalid cursor without hitting ClickHouse', async () => {
    await expect(
      service.list('contact-1', { cursor: 'not-base64-!!', limit: 50 }),
    ).rejects.toThrow(BadRequestException);

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('contact with no events returns empty list with hasNext=false', async () => {
    queryMock.mockResolvedValueOnce([]);

    const result = await service.list('contact-empty', { limit: 50 });

    expect(result.events).toEqual([]);
    expect(result.pagination).toEqual({
      nextCursor: null,
      hasNext: false,
      limit: 50,
    });
  });

  it('parses properties when string and passes through when object', async () => {
    queryMock.mockResolvedValueOnce([
      makeRow(0, { properties: '{"k":"v1"}', traits: '{"a":1}' }),
      makeRow(1, {
        properties: { k: 'v2' } as Record<string, unknown>,
        traits: { a: 2 } as Record<string, unknown>,
      }),
    ]);

    const result = await service.list('contact-1', { limit: 50 });

    expect(result.events[0].properties).toEqual({ k: 'v1' });
    expect(result.events[0].traits).toEqual({ a: 1 });
    expect(result.events[1].properties).toEqual({ k: 'v2' });
    expect(result.events[1].traits).toEqual({ a: 2 });
  });
});
