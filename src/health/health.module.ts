import { Module } from '@nestjs/common';
import { ProcessingModule } from '../modules/processing/processing.module';
import { getProcessingConfig } from '../modules/processing/config/processing.config';
import { HealthController } from './health.controller';
import { ACTIVE_INDICATORS } from './indicators/health-indicator.interface';
import { selectActiveIndicators } from './active-indicators';
import { PostgresHealthIndicator } from './indicators/postgres.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { BrokerHealthIndicator } from './indicators/broker.health-indicator';
import { ClickHouseHealthIndicator } from './indicators/clickhouse.health-indicator';
import { TemporalTaskQueueIndicator } from './indicators/temporal-task-queue.health-indicator';
import { TemporalConnectivityIndicator } from './indicators/temporal-connectivity.health-indicator';
import { TemporalQueueHealthModule } from '../modules/temporal/temporal-queue-health.module';

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
  // TemporalQueueHealthModule exports the journey-execution queue-health probe
  // (EVO-1764). It is dependency-light, so importing it into this always-on
  // module is safe in every RUN_MODE; the indicator is only *evaluated* in the
  // journey-worker modes (see selectActiveIndicators).
  imports: [ProcessingModule, TemporalQueueHealthModule],
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
        TemporalTaskQueueIndicator,
        TemporalConnectivityIndicator,
      ],
      useFactory: (
        postgres: PostgresHealthIndicator,
        redis: RedisHealthIndicator,
        broker: BrokerHealthIndicator,
        clickhouse: ClickHouseHealthIndicator,
        temporal: TemporalTaskQueueIndicator,
        temporalConnectivity: TemporalConnectivityIndicator,
      ) =>
        selectActiveIndicators(getProcessingConfig().runMode, {
          postgres,
          redis,
          broker,
          clickhouse,
          temporal,
          temporalConnectivity,
        }),
    },
  ],
})
export class HealthModule {}
