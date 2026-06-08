import { Injectable } from '@nestjs/common';
import { Counter, register } from 'prom-client';

const HITS_METRIC = 'idempotency_hits_total';
const MISSES_METRIC = 'idempotency_misses_total';

@Injectable()
export class IdempotencyMetrics {
  public readonly hits: Counter<string>;
  public readonly misses: Counter<string>;

  constructor() {
    this.hits =
      (register.getSingleMetric(HITS_METRIC) as Counter<string> | undefined) ??
      new Counter({
        name: HITS_METRIC,
        help: 'Idempotency checks that matched an existing key (duplicate dropped).',
      });
    this.misses =
      (register.getSingleMetric(MISSES_METRIC) as
        | Counter<string>
        | undefined) ??
      new Counter({
        name: MISSES_METRIC,
        help: 'Idempotency checks seen for the first time (marked for processing).',
      });
  }
}
