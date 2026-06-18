import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../modules/processing/clickhouse/clickhouse.service';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { withTimeout } from '../with-timeout';

/**
 * Readiness probe for ClickHouse: `SELECT 1`. Only added to the active set in
 * `event-process` mode (see HealthModule) — the other runner modes don't touch
 * ClickHouse, so they must not gate readiness on it.
 */
@Injectable()
export class ClickHouseHealthIndicator implements HealthIndicator {
  readonly name = 'clickhouse';

  constructor(private readonly clickhouse: ClickHouseService) {}

  async check(): Promise<IndicatorResult> {
    try {
      await withTimeout(
        () => this.clickhouse.query({ query: 'SELECT 1' }),
        3000,
        this.name,
      );
      return { name: this.name, status: 'up' };
    } catch (err) {
      return { name: this.name, status: 'down', error: (err as Error).message };
    }
  }
}
