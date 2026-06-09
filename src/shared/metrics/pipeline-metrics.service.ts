import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Summary, register } from 'prom-client';

const REQUEST_DURATION = 'evo_flow_request_duration_seconds';
const ERRORS_TOTAL = 'evo_flow_errors_total';
const THROUGHPUT_TOTAL = 'evo_flow_throughput_total';
const CONSUMER_LAG = 'evo_flow_consumer_lag';

/**
 * Per-mode operational metrics for the distributed pipeline (NFR33). Exposed on
 * the shared prom-client `register` so the existing `GET /metrics` endpoint
 * scrapes them. The `mode` label is the running `RUN_MODE`, matching the process
 * topology so a scrape can be attributed to a single mode.
 *
 * - request duration → Summary with p50/p95/p99 quantiles (`latency_p95`)
 * - errors → Counter by category (`error_rate` via PromQL rate())
 * - throughput → Counter of processed units (`throughput` via rate())
 * - consumer lag → Gauge by topic/queue (`consumer_lag`); only populated by
 *   modes that consume from the broker (producer modes leave it unset).
 */
@Injectable()
export class PipelineMetricsService {
  private readonly mode = process.env.RUN_MODE ?? 'unknown';

  readonly requestDuration: Summary<string>;
  readonly errors: Counter<string>;
  readonly throughput: Counter<string>;
  readonly consumerLag: Gauge<string>;

  constructor() {
    this.requestDuration =
      (register.getSingleMetric(REQUEST_DURATION) as
        | Summary<string>
        | undefined) ??
      new Summary({
        name: REQUEST_DURATION,
        help: 'Request/processing duration in seconds with p50/p95/p99 quantiles (10-min sliding window).',
        labelNames: ['mode', 'route'],
        percentiles: [0.5, 0.95, 0.99],
        // Sliding window so quantiles reflect recent traffic instead of
        // accumulating over the whole process lifetime (stale p95/p99).
        maxAgeSeconds: 600,
        ageBuckets: 5,
      });

    this.errors =
      (register.getSingleMetric(ERRORS_TOTAL) as Counter<string> | undefined) ??
      new Counter({
        name: ERRORS_TOTAL,
        help: 'Total errors by category, per mode (drives error_rate).',
        labelNames: ['mode', 'category'],
      });

    this.throughput =
      (register.getSingleMetric(THROUGHPUT_TOTAL) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: THROUGHPUT_TOTAL,
        help: 'Total units processed per mode (drives throughput).',
        labelNames: ['mode'],
      });

    this.consumerLag =
      (register.getSingleMetric(CONSUMER_LAG) as Gauge<string> | undefined) ??
      new Gauge({
        name: CONSUMER_LAG,
        help: 'Current consumer lag per topic/queue (set by consumer modes).',
        labelNames: ['mode', 'topic'],
      });
  }

  observeRequestDuration(route: string, seconds: number): void {
    this.requestDuration.labels(this.mode, route).observe(seconds);
  }

  incError(category: string): void {
    this.errors.labels(this.mode, category).inc();
  }

  incThroughput(value = 1): void {
    this.throughput.labels(this.mode).inc(value);
  }

  setConsumerLag(topic: string, lag: number): void {
    this.consumerLag.labels(this.mode, topic).set(lag);
  }
}
