import { Module } from '@nestjs/common';
import { EventProcessService } from './services/event-process.service';
import { EventsReceivedConsumer } from './services/events-received.consumer';
import { SignatureValidatorRegistry } from './services/signature-validator.registry';
import { EventProcessMetrics } from './metrics/event-process-metrics';
import { EnricherService } from './services/enricher.service';
import { ClickHouseWriterService } from './services/clickhouse-writer.service';
import { DlqPublisherService } from './services/dlq-publisher.service';
import { RecipientSourceExtractor } from './services/recipient-source.extractor';
import { GeoLocationService } from '../../modules/click-tracking/services/geo-location.service';

/**
 * Runner module for RUN_MODE=event-process (story 3.3 / EVO-1208).
 *
 * Boots the `events.received.<platform>` consumer end of the webhook pipeline.
 * IMESSAGE_BROKER (BrokerModule, @Global) and CorrelationContext
 * (CorrelationModule, @Global) come from their own modules, and ConfigService
 * is global (ConfigModule.forRoot isGlobal), so this module only declares the
 * consumer, handler, signature-validator registry and metrics. Imported
 * conditionally from AppModule.forRoot() when shouldStartEventProcess() is true.
 *
 * `GeoLocationService` is reused from click-tracking by declaring it as a
 * provider here (it has no injected dependencies), avoiding a dependency on the
 * whole `ClickTrackingModule` (story 3.6 / EVO-1212).
 */
@Module({
  providers: [
    EventProcessService,
    EventsReceivedConsumer,
    SignatureValidatorRegistry,
    EventProcessMetrics,
    EnricherService,
    ClickHouseWriterService,
    DlqPublisherService,
    RecipientSourceExtractor,
    GeoLocationService,
  ],
})
export class EventProcessModule {}
