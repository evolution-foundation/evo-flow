import { Module } from '@nestjs/common';
import { ProcessingModule } from '../processing/processing.module';
import { JourneyExecutionPollerService } from './services/journey-execution-poller.service';
import { TemporalTaskQueueIndicator } from '../../health/indicators/temporal-task-queue.health-indicator';

/**
 * Dependency-light home for the `journey-execution` queue-health poller +
 * readiness indicator (EVO-1764).
 *
 * Deliberately separate from the heavy, conditionally-loaded `TemporalModule`
 * (which drags in the campaign/event worker graph): the always-on `HealthModule`
 * and the unconditional `JourneysModule` both import THIS module to reach the
 * poller, so neither pulls the worker graph and there is no `TemporalModule ⇄
 * JourneysModule` cycle. Nest dedupes the module, so the poller is a single
 * shared singleton across both consumers.
 *
 * Imports `ProcessingModule` only for `PrometheusMetrics`. The poller's own
 * `onModuleInit` is a no-op outside journey-worker modes, so constructing it in
 * every RUN_MODE is cheap and safe.
 */
@Module({
  imports: [ProcessingModule],
  providers: [JourneyExecutionPollerService, TemporalTaskQueueIndicator],
  exports: [JourneyExecutionPollerService, TemporalTaskQueueIndicator],
})
export class TemporalQueueHealthModule {}
