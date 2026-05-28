/* eslint-disable no-console */
/**
 * Benchmark the 3 EVO-1246 representative queries against ClickHouse.
 *
 * Method per iteration:
 *   - Try to drop mark / uncompressed / query caches (skip if no privilege)
 *   - Issue the query with a unique query_id and SETTINGS max_execution_time=30
 *   - Pull duration / read_rows / read_bytes from system.query_log
 *
 * Caveats (documented in measurements.md):
 *   - "Mark-cache cold" is the best we can do without root. The OS page cache
 *     stays warm across iterations; iter 1 pays cold-page-cache cost, iters 2-N
 *     only cold marks. We discard the first `--warmup` iters (default 10) to
 *     stabilize on the steady-state distribution.
 *   - Quantiles use linear interpolation (R7) so P99 != max for n=100.
 *
 * Usage:
 *   pnpm ts-node scripts/bench-segment-queries.ts --iters 100 --warmup 10
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { randomUUID } from 'crypto';

type Args = { iters: number; warmup: number; minRows: number };

function parseArgs(argv: string[]): Args {
  const out: Args = { iters: 100, warmup: 10, minRows: 1_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iters') out.iters = Number(argv[++i]);
    else if (a === '--warmup') out.warmup = Number(argv[++i]);
    else if (a === '--min-rows') out.minRows = Number(argv[++i]);
  }
  if (!Number.isInteger(out.iters) || out.iters <= 0)
    throw new Error('--iters must be a positive integer');
  if (!Number.isInteger(out.warmup) || out.warmup < 0)
    throw new Error('--warmup must be a non-negative integer');
  if (out.warmup >= out.iters)
    throw new Error('--warmup must be < --iters');
  if (!Number.isInteger(out.minRows) || out.minRows < 0)
    throw new Error('--min-rows must be a non-negative integer');
  return out;
}

function client(): ClickHouseClient {
  return createClient({
    url: `${process.env.CLICKHOUSE_PROTOCOL || 'http'}://${process.env.CLICKHOUSE_HOST || 'localhost'}:${process.env.CLICKHOUSE_PORT || '8123'}`,
    database: process.env.CLICKHOUSE_DATABASE || 'evo_campaign',
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    request_timeout: 600_000,
  });
}

// All windows are fixed-day so Q2/Q3 are comparable. Per-query SETTINGS bound
// per-iteration runtime to 30 s — a runaway can't burn the timebox.
const QUERIES: Record<string, string> = {
  Q1: `
    SELECT DISTINCT ce.contact_id
    FROM evo_campaign.contact_events ce
    WHERE ce.event_name = 'message.opened'
      AND ce.occurred_at >= now() - INTERVAL 7 DAY
    GROUP BY ce.contact_id
    SETTINGS max_execution_time = 30
  `,
  Q2: `
    SELECT DISTINCT ce.contact_id
    FROM evo_campaign.contact_events ce
    WHERE ce.event_name = 'campaign.message.clicked'
      AND ce.occurred_at >= now() - INTERVAL 30 DAY
      AND ce.contact_id NOT IN (
        SELECT DISTINCT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'message.replied'
          AND occurred_at >= now() - INTERVAL 30 DAY
          AND contact_id IS NOT NULL
      )
    GROUP BY ce.contact_id
    SETTINGS max_execution_time = 30
  `,
  Q3: `
    SELECT DISTINCT ce.contact_id
    FROM evo_campaign.contact_events ce
    WHERE ce.event_name = 'web.pageview'
      AND ce.occurred_at >= now() - INTERVAL 30 DAY
    GROUP BY ce.contact_id
    HAVING COUNT(*) >= 5
    SETTINGS max_execution_time = 30
  `,
};

async function rawQuery(c: ClickHouseClient, q: string): Promise<string> {
  const r = await c.query({ query: q, format: 'TabSeparatedRaw' });
  return await r.text();
}

async function runExplain(
  c: ClickHouseClient,
  query: string,
  mode: 'indexes' | 'pipeline',
): Promise<string> {
  const explainQ =
    mode === 'indexes'
      ? `EXPLAIN indexes = 1 ${query}`
      : `EXPLAIN PIPELINE ${query}`;
  return await rawQuery(c, explainQ);
}

interface BenchResult {
  ids: string[];
  durations: number[];
  readRows: number[];
  readBytes: number[];
  cachesDropped: string[];
  cachesDenied: string[];
}

const CACHE_DROPS = [
  { name: 'mark', query: 'SYSTEM DROP MARK CACHE' },
  { name: 'uncompressed', query: 'SYSTEM DROP UNCOMPRESSED CACHE' },
  { name: 'query', query: 'SYSTEM DROP QUERY CACHE' },
] as const;

interface CacheDropStatus {
  dropped: string[];
  denied: string[];
}

async function tryDropCaches(c: ClickHouseClient): Promise<CacheDropStatus> {
  // Drop everything ClickHouse owns. OS page cache stays warm — see measurements.md.
  // Track per-cache outcome so the report can distinguish full-drop, partial-drop,
  // and full-denial (R6 from code review).
  const dropped: string[] = [];
  const denied: string[] = [];
  for (const { name, query } of CACHE_DROPS) {
    try {
      await c.command({ query });
      dropped.push(name);
    } catch (err: any) {
      if (/Not enough privileges|Access denied/i.test(err?.message ?? '')) {
        denied.push(name);
        continue;
      }
      throw err;
    }
  }
  return { dropped, denied };
}

async function benchmark(
  c: ClickHouseClient,
  query: string,
  iters: number,
): Promise<BenchResult> {
  const ids: string[] = [];
  const startTs = Math.floor(Date.now() / 1000) - 5; // 5 s skew for log flush
  const droppedSet = new Set<string>();
  const deniedSet = new Set<string>();

  for (let i = 0; i < iters; i++) {
    const status = await tryDropCaches(c);
    status.dropped.forEach((n) => droppedSet.add(n));
    status.denied.forEach((n) => deniedSet.add(n));
    const queryId = randomUUID();
    ids.push(queryId);
    const r = await c.query({ query, format: 'JSONEachRow', query_id: queryId });
    await r.text();
  }

  await c.command({ query: 'SYSTEM FLUSH LOGS' });

  const idList = ids.map((id) => `'${id}'`).join(', ');
  // ORDER BY event_time so the returned rows are in iteration order — required
  // for `slice(warmup)` to actually drop the first-N cold-start iterations
  // (R2 from code review). Without this, slice drops arbitrary entries.
  const r = await c.query({
    query: `
      SELECT
        query_id,
        query_duration_ms,
        read_rows,
        read_bytes
      FROM system.query_log
      WHERE query_id IN (${idList})
        AND event_time >= toDateTime(${startTs})
        AND type = 'QueryFinish'
      ORDER BY event_time ASC, event_time_microseconds ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{
    query_id: string;
    query_duration_ms: string;
    read_rows: string;
    read_bytes: string;
  }>();

  if (rows.length !== ids.length) {
    throw new Error(
      `query_log returned ${rows.length} rows for ${ids.length} iterations — log flush incomplete or query_id collision`,
    );
  }

  const durations: number[] = [];
  const readRows: number[] = [];
  const readBytes: number[] = [];
  for (const row of rows) {
    durations.push(Number(row.query_duration_ms));
    readRows.push(Number(row.read_rows));
    readBytes.push(Number(row.read_bytes));
  }
  return {
    ids,
    durations,
    readRows,
    readBytes,
    cachesDropped: [...droppedSet],
    cachesDenied: [...deniedSet],
  };
}

// R7 linear-interpolation quantile (R/numpy default).
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function summarize(label: string, values: number[]): string {
  if (values.length === 0) return `${label}: <no samples>`;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  return [
    `${label} (n=${sorted.length})`,
    `  min=${sorted[0]}`,
    `  P50=${quantile(sorted, 0.5).toFixed(2)}`,
    `  P95=${quantile(sorted, 0.95).toFixed(2)}`,
    `  P99=${quantile(sorted, 0.99).toFixed(2)}`,
    `  max=${sorted[sorted.length - 1]}`,
    `  mean=${mean.toFixed(2)}`,
    `  stddev=${stddev(values).toFixed(2)}`,
  ].join('\n');
}

async function main() {
  const { iters, warmup, minRows } = parseArgs(process.argv.slice(2));

  const c = client();
  console.log(`# Benchmark (iters=${iters}, warmup=${warmup} discarded)`);
  console.log('');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log('');

  // AC1 precondition: bail if seed wasn't run / pointed at wrong DB.
  const total = await rawQuery(
    c,
    'SELECT count() FROM evo_campaign.contact_events',
  );
  const totalRows = Number(total.trim());
  console.log(`evo_campaign.contact_events row count: ${totalRows.toLocaleString()}`);
  if (totalRows < minRows) {
    throw new Error(
      `Precondition failure: row count ${totalRows} < --min-rows ${minRows}. Did you run the seeder?`,
    );
  }
  console.log('');

  for (const [label, query] of Object.entries(QUERIES)) {
    console.log(`---\n\n## ${label}\n`);
    console.log('### SQL\n');
    console.log('```sql');
    console.log(query.trim());
    console.log('```\n');

    console.log('### EXPLAIN indexes = 1\n');
    console.log('```');
    console.log((await runExplain(c, query, 'indexes')).trim());
    console.log('```\n');

    console.log('### EXPLAIN PIPELINE\n');
    console.log('```');
    console.log((await runExplain(c, query, 'pipeline')).trim());
    console.log('```\n');

    console.log(`### Benchmark (first ${warmup} discarded as warmup)\n`);
    const t0 = Date.now();
    const res = await benchmark(c, query, iters);
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    const trimmedDur = res.durations.slice(warmup);
    const trimmedRows = res.readRows.slice(warmup);
    const trimmedBytes = res.readBytes.slice(warmup);
    console.log('```');
    const cacheParts: string[] = [];
    if (res.cachesDropped.length > 0) cacheParts.push(res.cachesDropped.join('+'));
    if (res.cachesDenied.length > 0) cacheParts.push(`(${res.cachesDenied.join('+')} DENIED)`);
    console.log(`cache_drop=${cacheParts.join(' ') || 'NONE'}`);
    console.log(summarize('query_duration_ms', trimmedDur));
    console.log(summarize('read_rows', trimmedRows));
    console.log(summarize('read_bytes', trimmedBytes));
    console.log(`wall_clock_total=${wallSec}s`);
    console.log('```\n');
  }

  await c.close();
}

main().catch((err) => {
  console.error('[bench] FAILED:', err);
  process.exit(1);
});
