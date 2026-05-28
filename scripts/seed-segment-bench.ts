/* eslint-disable no-console */
/**
 * Seed evo_campaign.contact_events with synthetic rows for the EVO-1246 bench.
 *
 * Distribution choices (documented because they shape the benchmark):
 *   - event_name: 40 % message.opened / 25 % campaign.message.clicked /
 *     15 % message.replied / 20 % web.pageview — matches the 3 ticket queries.
 *   - contact_id: quadratic skew over `--contacts` ids — bucket =
 *     floor(pow(rand()/UINT32_MAX, 2.0) * contacts), clamped to
 *     [0, contacts-1]. Not a true Zipf/Pareto (no power-law tail), but
 *     produces a heavy head (popular contacts) and long tail similar enough
 *     to a real workload that bloom-filter selectivity is more honest than
 *     uniform mod-based assignment.
 *   - contact_or_anonymous_id: same bucket as contact_id — matches the
 *     production schema invariant (when non-anonymous, the two columns are
 *     equal).
 *   - occurred_at: bursty time clusters — 70 % of events fall into the most
 *     recent 30 % of the window, the rest spread across the full window.
 *     Avoids the prior "every contact evenly spread" artifact.
 *
 * Direct INSERT, no Kafka — we want benchmark-shaped data without pipeline
 * noise. processingService.processEvent is bypassed intentionally.
 *
 * Usage:
 *   pnpm ts-node scripts/seed-segment-bench.ts \
 *     --rows 10000000 --days 90 --contacts 50000
 */

import { createClient } from '@clickhouse/client';

function parseArgs(argv: string[]): {
  rows: number;
  days: number;
  contacts: number;
} {
  const out = { rows: 1_000_000, days: 90, contacts: 50_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rows') out.rows = Number(argv[++i]);
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--contacts') out.contacts = Number(argv[++i]);
  }
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`--${k} must be a positive integer`);
    }
  }
  return out;
}

async function main() {
  const { rows, days, contacts } = parseArgs(process.argv.slice(2));

  const protocol = process.env.CLICKHOUSE_PROTOCOL || 'http';
  const host = process.env.CLICKHOUSE_HOST || 'localhost';
  const port = process.env.CLICKHOUSE_PORT || '8123';
  const database = process.env.CLICKHOUSE_DATABASE || 'evo_campaign';
  const username = process.env.CLICKHOUSE_USERNAME || 'default';
  const password = process.env.CLICKHOUSE_PASSWORD || '';

  const client = createClient({
    url: `${protocol}://${host}:${port}`,
    database,
    username,
    password,
    request_timeout: 600_000,
  });

  console.log(
    `[seed] Connecting to ${protocol}://${host}:${port} db=${database} user=${username}`,
  );
  const ver = await client.query({ query: 'SELECT version()', format: 'JSONEachRow' });
  const verRow = (await ver.json<{ 'version()': string }>())[0];
  console.log(`[seed] ClickHouse version: ${verRow?.['version()'] ?? 'unknown'}`);

  // Compute the contact bucket and occurred_at ONCE per row in a subquery, so:
  //   * contact_id and contact_or_anonymous_id share the same bucket
  //     (matches the production schema invariant)
  //   * the time expression isn't duplicated
  //   * bucket clamps to [0, contacts-1] — pow(1.0, 2.0) * contacts would
  //     otherwise produce `contacts`, one index out of range.
  // rand() returns UInt32 (max = 4294967295), so divide by that to get [0, 1].
  // Quadratic skew (pow(x, 2.0)) biases toward low buckets — heavy head, long tail.
  const insert = `
    INSERT INTO ${database}.contact_events (
      contact_id, event_type, event_name, properties, traits,
      anonymous_id, message_id, occurred_at, processing_time,
      message_raw, contact_or_anonymous_id
    )
    SELECT
      concat('bench-', toString(bucket)) AS contact_id,
      'track' AS event_type,
      multiIf(
        (number % 100) < 40, 'message.opened',
        (number % 100) < 65, 'campaign.message.clicked',
        (number % 100) < 80, 'message.replied',
                             'web.pageview'
      ) AS event_name,
      '{}' AS properties,
      '{}' AS traits,
      NULL AS anonymous_id,
      NULL AS message_id,
      ts AS occurred_at,
      now() AS processing_time,
      '{}' AS message_raw,
      concat('bench-', toString(bucket)) AS contact_or_anonymous_id
    FROM (
      SELECT
        number,
        toUInt64(least(
          floor(pow(rand(number) / 4294967295.0, 2.0) * ${contacts}),
          ${contacts - 1}
        )) AS bucket,
        multiIf(
          (rand(number + 1) % 100) < 70,
            now() - toIntervalSecond(toUInt64(rand(number + 2) % toUInt64(${days} * 86400 * 0.3))),
            now() - toIntervalSecond(toUInt64(rand(number + 3) % toUInt64(${days} * 86400)))
        ) AS ts
      FROM numbers(${rows})
    )
  `;

  console.log(
    `[seed] Inserting ${rows.toLocaleString()} rows, quadratic-skewed over ${contacts.toLocaleString()} contacts, bursty over ${days} days...`,
  );
  const t0 = Date.now();
  await client.command({ query: insert });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[seed] Insert completed in ${elapsed}s`);

  const countQ = await client.query({
    query: `SELECT count() AS c FROM ${database}.contact_events`,
    format: 'JSONEachRow',
  });
  const [{ c }] = await countQ.json<{ c: string }>();
  console.log(`[seed] Total rows in ${database}.contact_events: ${c}`);

  const dist = await client.query({
    query: `
      SELECT event_name, count() AS c
      FROM ${database}.contact_events
      WHERE contact_id LIKE 'bench-%'
      GROUP BY event_name
      ORDER BY c DESC
    `,
    format: 'JSONEachRow',
  });
  console.log('[seed] Event-name distribution (bench rows):');
  for (const row of await dist.json<{ event_name: string; c: string }>()) {
    console.log(`  ${row.event_name.padEnd(28)} ${row.c}`);
  }

  // Quick sanity on contact skew: how concentrated is the head?
  const skew = await client.query({
    query: `
      WITH per_contact AS (
        SELECT contact_id, count() AS c
        FROM ${database}.contact_events
        WHERE contact_id LIKE 'bench-%'
        GROUP BY contact_id
      )
      SELECT
        count() AS distinct_contacts,
        quantile(0.50)(c) AS p50,
        quantile(0.95)(c) AS p95,
        quantile(0.99)(c) AS p99,
        max(c) AS top
      FROM per_contact
    `,
    format: 'JSONEachRow',
  });
  const skewRow = (await skew.json<Record<string, string>>())[0];
  console.log('[seed] Per-contact event count (skew check):');
  console.log(
    `  distinct=${skewRow.distinct_contacts}, P50=${skewRow.p50}, P95=${skewRow.p95}, P99=${skewRow.p99}, max=${skewRow.top}`,
  );

  await client.close();
}

main().catch((err) => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
