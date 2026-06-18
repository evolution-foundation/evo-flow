import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { withTimeout } from '../with-timeout';

/** Readiness probe for Postgres: `SELECT 1` over the TypeORM connection. */
@Injectable()
export class PostgresHealthIndicator implements HealthIndicator {
  readonly name = 'postgres';

  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<IndicatorResult> {
    try {
      await withTimeout(
        () => this.dataSource.query('SELECT 1'),
        3000,
        this.name,
      );
      return { name: this.name, status: 'up' };
    } catch (err) {
      return { name: this.name, status: 'down', error: (err as Error).message };
    }
  }
}
