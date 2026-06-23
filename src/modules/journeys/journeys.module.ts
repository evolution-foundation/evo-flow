import { Module, Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// BullModule removed - using Temporal timers instead
import { Journey } from './entities/journey.entity';
import { JourneySession } from './entities/journey-session.entity';
import { ScheduledJourneyAction } from './entities/scheduled-journey-action.entity';
import { JourneysService } from './journeys.service';
import { JourneysController } from './journeys.controller';
import { JourneySessionsController } from './journey-sessions.controller';
import { ScheduledActionsController } from './scheduled-actions.controller';
import { JourneyTriggerProcessor } from './services/journey-trigger-processor.service';
import { JourneySessionsService } from './services/journey-sessions.service';
import { WaitRegistryService } from './services/wait-registry.service';
// WaitCheckerJob removed - using Temporal timers instead of Bull queues
import { ProcessingModule } from '../processing/processing.module';
import { CacheModule } from '../cache/cache.module';
import { TemporalQueueHealthModule } from '../temporal/temporal-queue-health.module';
import { AppFactory } from '../../app-factory';

// Only include JourneyTriggerProcessor if we should start temporal worker
const moduleProviders: Type<any>[] = [JourneysService, JourneySessionsService, WaitRegistryService];
const moduleExports: Type<any>[] = [JourneysService, JourneySessionsService, WaitRegistryService];

// Debug logging removed

if (AppFactory.shouldStartTemporalWorker()) {
  moduleProviders.push(JourneyTriggerProcessor);
  moduleExports.push(JourneyTriggerProcessor);
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Journey, JourneySession, ScheduledJourneyAction]),
    // BullModule removed - using Temporal timers instead of Bull queues for wait processing
    ProcessingModule,
    CacheModule, // 🚀 PERFORMANCE: Import cache services for journey performance
    TemporalQueueHealthModule, // EVO-1764: queue-health poller for the dispatch guard
  ],
  controllers: [JourneysController, JourneySessionsController, ScheduledActionsController],
  providers: moduleProviders,
  exports: moduleExports,
})
export class JourneysModule {}
