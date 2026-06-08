import { Module } from '@nestjs/common';
import { EventProcessService } from './services/event-process.service';
import { EventsReceivedConsumer } from './services/events-received.consumer';

/**
 * Runner module for RUN_MODE=event-process (story 3.3 / EVO-1208).
 *
 * Boots the `events.received.<platform>` consumer end of the webhook pipeline.
 * IMESSAGE_BROKER (BrokerModule, @Global) and CorrelationContext
 * (CorrelationModule, @Global) come from their own modules, so this module only
 * declares the consumer + stub handler. Imported conditionally from
 * AppModule.forRoot() when AppFactory.shouldStartEventProcess() is true.
 */
@Module({
  providers: [EventProcessService, EventsReceivedConsumer],
})
export class EventProcessModule {}
