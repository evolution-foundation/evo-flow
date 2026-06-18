import { Module } from '@nestjs/common';
import { ProcessingModule } from '../modules/processing/processing.module';
import { getProcessingConfig } from '../modules/processing/config/processing.config';
import { RunMode } from '../modules/processing/enums/run-mode.enum';
import { HealthController } from './health.controller';
import {
  ACTIVE_INDICATORS,
  HealthIndicator,
} from './indicators/health-indicator.interface';
import { PostgresHealthIndicator } from './indicators/postgres.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { BrokerHealthIndicator } from './indicators/broker.health-indicator';
import { ClickHouseHealthIndicator } from './indicators/clickhouse.health-indicator';

/**
 * Reusable health module imported by every RUN_MODE (EVO-1226 [5.1]). It owns
 * the `/health` + `/ready` endpoints and assembles the indicator set relevant
 * to the active mode: Postgres + Redis + Broker for all, plus ClickHouse only
 * for `event-process`.
 *
 * `imports: [ProcessingModule]` is required for `ClickHouseService` (the module
 * exports it but is not @Global). `DataSource` and `IMESSAGE_BROKER` resolve
 * from the global graph.
 */
@Module({
  imports: [ProcessingModule],
  controllers: [HealthController],
  providers: [
    PostgresHealthIndicator,
    RedisHealthIndicator,
    BrokerHealthIndicator,
    ClickHouseHealthIndicator,
    {
      provide: ACTIVE_INDICATORS,
      inject: [
        PostgresHealthIndicator,
        RedisHealthIndicator,
        BrokerHealthIndicator,
        ClickHouseHealthIndicator,
      ],
      useFactory: (
        postgres: PostgresHealthIndicator,
        redis: RedisHealthIndicator,
        broker: BrokerHealthIndicator,
        clickhouse: ClickHouseHealthIndicator,
      ) => {
        const mode = getProcessingConfig().runMode;
        const active: HealthIndicator[] = [postgres, redis, broker];
        if (mode === RunMode.EVENT_PROCESS) {
          active.push(clickhouse);
        }
        return active;
      },
    },
  ],
})
export class HealthModule {}
