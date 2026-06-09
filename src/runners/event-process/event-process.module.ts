import { Module } from '@nestjs/common';
import { EventProcessService } from './services/event-process.service';
import { EventsReceivedConsumer } from './services/events-received.consumer';
import { SignatureValidatorRegistry } from './services/signature-validator.registry';
import { EventProcessMetrics } from './metrics/event-process-metrics';

/**
 * Runner module for RUN_MODE=event-process (story 3.3 / EVO-1208).
 *
 * Boots the `events.received.<platform>` consumer end of the webhook pipeline.
 * IMESSAGE_BROKER (BrokerModule, @Global) and CorrelationContext
 * (CorrelationModule, @Global) come from their own modules, and ConfigService
 * is global (ConfigModule.forRoot isGlobal), so this module only declares the
 * consumer, handler, signature-validator registry and metrics. Imported
 * conditionally from AppModule.forRoot() when shouldStartEventProcess() is true.
 */
@Module({
  providers: [
    EventProcessService,
    EventsReceivedConsumer,
    SignatureValidatorRegistry,
    EventProcessMetrics,
  ],
})
export class EventProcessModule {}
