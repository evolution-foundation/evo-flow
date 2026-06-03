import { Module } from '@nestjs/common';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookIntakeService } from './services/webhook-intake.service';

/**
 * Runner module for RUN_MODE=event-receiver (story 3.1 / EVO-1207).
 *
 * Boots the catch-all POST /webhooks/* receiver. CustomLoggerService and the
 * correlation infra (story 2.5 / EVO-1206) come from their global modules
 * (CommonModule / CorrelationModule), so this module only declares the
 * receiver's own controller + intake seam. Imported conditionally from
 * AppModule.forRoot() when AppFactory.shouldStartEventReceiver() is true.
 */
@Module({
  controllers: [WebhooksController],
  providers: [WebhookIntakeService],
})
export class EventReceiverModule {}
