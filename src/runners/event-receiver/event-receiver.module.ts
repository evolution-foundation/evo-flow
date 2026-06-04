import { Module } from '@nestjs/common';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookIntakeService } from './services/webhook-intake.service';
import { PlatformDetectorService } from './services/platform-detector.service';
import { PayloadNormalizerService } from './services/payload-normalizer.service';

/**
 * Runner module for RUN_MODE=event-receiver (stories 3.1 / EVO-1207 and
 * 3.2 / EVO-1209).
 *
 * Boots the catch-all POST /webhooks/* receiver and the broker bridge
 * (detector + normalizer + IMessageBroker.publish). CustomLoggerService, the
 * correlation infra (story 2.5 / EVO-1206) and IMESSAGE_BROKER (BrokerModule,
 * @Global) come from their own modules, so this module only declares the
 * receiver's own controller + intake seam + detector/normalizer. Imported
 * conditionally from AppModule.forRoot() when
 * AppFactory.shouldStartEventReceiver() is true.
 */
@Module({
  controllers: [WebhooksController],
  providers: [
    WebhookIntakeService,
    PlatformDetectorService,
    PayloadNormalizerService,
  ],
})
export class EventReceiverModule {}
