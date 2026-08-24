import { createClient, ClickHouseClient } from '@clickhouse/client';
import { SegmentClickHouseQueryBuilderService } from '../src/modules/segments/services/segment-clickhouse-query-builder.service';
import {
  Segment,
  SegmentNodeType,
} from '../src/modules/segments/entities/segment.entity';

/**
 * CRM-241 — end-to-end proof of the card's acceptance criteria: a Performed node
 * filtered by `labelName` / `attributeName` must RETURN THE RIGHT CONTACTS, not
 * merely produce the expected SQL string.
 *
 * The unit spec (segment-clickhouse-query-builder.service.spec.ts) pins the SQL.
 * It cannot prove the SQL matches any row — and that is exactly where the bug
 * lived: the old expression was valid SQL, ran without error, and silently matched
 * nothing because it read the wrong column.
 *
 * Here the condition the builder generates is executed against a real ClickHouse,
 * over rows shaped the way the pipeline actually writes them:
 *   - contact event  → arrives as `identify`: payload in `traits`, `properties` = {}
 *   - campaign event → arrives as `track`:    payload in `properties`, `traits` = {}
 *
 * Requires a ClickHouse — and FAILS if none is reachable, instead of skipping.
 * Runs the same on both environments; point the URL at whichever is up:
 *   CLICKHOUSE_URL=http://localhost:18123 npm run test:e2e -- segment-where-properties  # community
 *   CLICKHOUSE_URL=http://localhost:18124 npm run test:e2e -- segment-where-properties  # ecosystem
 *
 * The scenario lives in a mirror table the test creates and drops, so nothing is
 * read from or written to the real `contact_events`.
 */
const URL = process.env.CLICKHOUSE_URL || 'http://localhost:18123';
const DB = process.env.CLICKHOUSE_DB || 'evo_campaign';
const USER = process.env.CLICKHOUSE_USERNAME || 'default';
const PASS = process.env.CLICKHOUSE_PASSWORD || 'password';

// MIRROR table, created with `AS contact_events` — same schema, without the
// materialized views attached to it.
//
// The reason is concrete: `clickhouse.service.ts` always creates
// `events_to_journey_triggers_mv` writing into `journey_trigger_kafka_queue` (a
// Kafka engine), including on an environment whose broker is RabbitMQ
// (`BROKER_TYPE=rabbitmq`, the community compose). With no Kafka broker answering,
// every INSERT into the real table hangs until the timeout — verified over plain
// HTTP, outside the test. On the ecosystem, which runs an actual Kafka, the same
// INSERT answers in ~2s.
//
// The mirror keeps the test deterministic on BOTH environments and preserves
// isolation: what it has to prove is the EXPRESSION the builder generates against
// realistically shaped rows, and the copied schema is identical to production's.
//
// Verified against ClickHouse 26.7 (community, :18123) and 25.8 (ecosystem, :18124).
const TABLE = `crm241_e2e_${Date.now()}_${process.pid}`;
const TAG = 'crm241'; // id prefix for the scenario rows, for readability only

const VIP = `${TAG}-vip`;
const COMUM = `${TAG}-comum`;
const CAMPANHA = `${TAG}-campanha`;

describe('CRM-241 whereProperties matches real rows in ClickHouse (e2e)', () => {
  let client: ClickHouseClient;
  const builder = new SegmentClickHouseQueryBuilderService();
  const segment = { id: 'seg-241-e2e' } as Segment;

  beforeAll(async () => {
    client = createClient({
      url: URL,
      database: DB,
      username: USER,
      password: PASS,
      request_timeout: 60_000,
      clickhouse_settings: {
        // The two environments differ here: the community compose ships
        // `async_insert=1` in users.xml, the ecosystem one stays at the default 0.
        // With `async_insert=1` (and `wait_for_async_insert=1`, on in both) the
        // client is held waiting for the buffer flush instead of writing straight
        // through. Pinning 0 makes the INSERT synchronous and the test
        // deterministic wherever it runs.
        async_insert: 0,
      },
    });

    try {
      await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    } catch (error) {
      // Fail, do not skip. A conditional skip here would be worse than having no
      // test at all: the suite would go GREEN without exercising anything — the
      // same silent-failure mode CRM-241 fixes. (And a flag-driven `it.skip` would
      // not even work: Jest evaluates that at collection time, before this hook.)
      throw new Error(
        `[CRM-241 e2e] ClickHouse unreachable at ${URL} (db=${DB}, user=${USER}): ` +
          `${(error as Error).message}. Bring the compose up, or point ` +
          `CLICKHOUSE_URL/CLICKHOUSE_USERNAME/CLICKHOUSE_PASSWORD at a live one.`,
      );
    }

    await client.command({
      query: `CREATE TABLE ${DB}.${TABLE} AS ${DB}.contact_events`,
    });

    const now = new Date().toISOString().replace('T', ' ').substring(0, 23);
    const row = (
      id: string,
      type: 'identify' | 'track',
      event: string,
      properties: object,
      traits: object,
    ) => ({
      contact_id: id,
      contact_or_anonymous_id: id,
      event_type: type,
      event_name: event,
      properties: JSON.stringify(properties),
      traits: JSON.stringify(traits),
      message_id: `${id}-${event}`,
      occurred_at: now,
      processing_time: now,
      message_raw: '{}',
    });

    await client.insert({
      table: `${DB}.${TABLE}`,
      format: 'JSONEachRow',
      values: [
        // Exactly how the CRM emits it: identify, everything in traits, properties
        // empty.
        row(VIP, 'identify', 'contact.label.added', {}, { labelName: 'VIP', labelId: 'lb-1' }),
        row(COMUM, 'identify', 'contact.label.added', {}, { labelName: 'Comum', labelId: 'lb-2' }),
        row(
          COMUM,
          'identify',
          'contact.custom_attribute.changed',
          {},
          { attributeName: 'plano', attributeValue: 'free' },
        ),
        // Campaign event: track, everything in properties, traits empty. This is
        // what proves reading `properties` did NOT regress.
        row(CAMPANHA, 'track', 'whatsapp_sent', { template_id: 'tpl-42' }, {}),
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await client?.command({ query: `DROP TABLE IF EXISTS ${DB}.${TABLE}` });
    await client?.close();
  });

  /** Runs the condition the builder produced and returns the contacts it selects. */
  const contactsFor = async (node: object): Promise<string[]> => {
    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node as any);
    const rs = await client.query({
      query:
        `SELECT DISTINCT contact_or_anonymous_id AS id FROM ${DB}.${TABLE} ` +
        `WHERE ${subQuery.condition} ORDER BY id`,
      format: 'JSONEachRow',
    });
    return (await rs.json<{ id: string }>()).map((r) => r.id);
  };

  const performed = (event: string, properties: object[]) => ({
    id: 'n1',
    type: SegmentNodeType.Performed,
    event,
    properties,
  });

  const prop = (path: string, type: string, value?: string) => ({
    path,
    operator: { type, ...(value === undefined ? {} : { value }) },
  });

  it('labelName = VIP returns only the VIP contact', async () => {
    const ids = await contactsFor(
      performed('contact.label.added', [prop('labelName', 'Equals', 'VIP')]),
    );
    expect(ids).toEqual([VIP]);
  });

  it('attributeName = plano returns the contact holding the attribute', async () => {
    const ids = await contactsFor(
      performed('contact.custom_attribute.changed', [
        prop('attributeName', 'Equals', 'plano'),
      ]),
    );
    expect(ids).toEqual([COMUM]);
  });

  // The dangerous half of the bug: the old expression compared '' against the
  // value, which was always true — the filter did not filter, and a campaign went
  // out to the wrong audience.
  it('labelName != VIP excludes the VIP instead of letting everyone through', async () => {
    const ids = await contactsFor(
      performed('contact.label.added', [prop('labelName', 'NotEquals', 'VIP')]),
    );
    expect(ids).toEqual([COMUM]);
    expect(ids).not.toContain(VIP);
  });

  it('labelName containing "VI" returns the VIP', async () => {
    const ids = await contactsFor(
      performed('contact.label.added', [prop('labelName', 'Contains', 'VI')]),
    );
    expect(ids).toEqual([VIP]);
  });

  it('Exists on labelName returns both labelled contacts', async () => {
    const ids = await contactsFor(
      performed('contact.label.added', [prop('labelName', 'Exists')]),
    );
    expect(ids).toEqual([COMUM, VIP]);
  });

  it('NotExists on labelName returns nobody who carries the label', async () => {
    const ids = await contactsFor(
      performed('contact.label.added', [prop('labelName', 'NotExists')]),
    );
    expect(ids).toEqual([]);
  });

  // Non-regression: a track event is still read from `properties`.
  it('template_id on a campaign event still matches', async () => {
    const ids = await contactsFor(
      performed('whatsapp_sent', [prop('template_id', 'Equals', 'tpl-42')]),
    );
    expect(ids).toEqual([CAMPANHA]);
  });

  // Proof that this test is NOT tautological: the old expression, run against the
  // very same rows, returns the wrong set in both directions.
  it('the old expression gets it wrong both ways on these same rows', async () => {
    const old = (path: string) => `JSONExtractString(properties, '${path}')`;
    const run = async (where: string) => {
      const rs = await client.query({
        query:
          `SELECT DISTINCT contact_or_anonymous_id AS id FROM ${DB}.${TABLE} ` +
          `WHERE event_name = 'contact.label.added' AND (${where}) ORDER BY id`,
        format: 'JSONEachRow',
      });
      return (await rs.json<{ id: string }>()).map((r) => r.id);
    };

    // Equals: used to return nothing — an empty segment.
    expect(await run(`${old('labelName')} = 'VIP'`)).toEqual([]);
    // NotEquals: used to return everyone, including the VIP that should be out.
    expect(await run(`${old('labelName')} != 'VIP'`)).toEqual([COMUM, VIP]);
  });
});
