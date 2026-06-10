import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  IMessageBroker,
  IMESSAGE_BROKER,
} from 'src/shared/broker/interfaces/message-broker.interface';
import {
  EVENTS_FAILED_TOPIC,
  EventsFailedContract,
} from 'src/shared/broker/contracts/events-failed.contract';
import { readCorrelationIdFromCls } from 'src/shared/correlation/correlation.util';
import { EventProcessMetrics } from '../metrics/event-process-metrics';

/**
 * Dedicated publisher for the `events.failed` DLQ (story 3.8 / EVO-1214).
 *
 * Any point of the event-process pipeline that decides "do not retry anymore"
 * hands the event here so nothing is lost silently; operators inspect and
 * reprocess manually in the MVP (see this runner's README for the runbook —
 * including the idempotency-TTL caveat on reprocessing).
 *
 * `correlationId` resolution: explicit parameter (callers outside a CLS
 * context, e.g. batch loops) → AsyncLocalStorage (story 2.5) → a fresh UUID
 * with a warning, since the contract requires one and a DLQ entry without
 * traceability is still better than a dropped event.
 *
 * Publish failures are LOGGED + COUNTED, never thrown: this is the last
 * resort, and callers must still ack their broker message — rethrowing would
 * trigger redelivery of a payload the pipeline already gave up on.
 */
@Injectable()
export class DlqPublisherService {
  private readonly logger = new CustomLoggerService(DlqPublisherService.name);

  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly metrics: EventProcessMetrics,
  ) {}

  async publish(
    originalTopic: string,
    originalPayload: unknown,
    failureReason: string,
    attempts: number,
    correlationId?: string,
  ): Promise<void> {
    const resolvedCorrelationId =
      correlationId ?? readCorrelationIdFromCls() ?? this.fallbackId();

    const payload: EventsFailedContract = {
      originalTopic,
      originalPayload,
      failureReason,
      attempts,
      lastFailureAt: new Date().toISOString(),
      correlationId: resolvedCorrelationId,
    };

    try {
      await this.broker.publish(EVENTS_FAILED_TOPIC, payload);
      this.metrics.eventsFailedPublishedTotal.inc({ reason: failureReason });
      this.logger.log('dlq-publisher.published', {
        action: 'dlq-publisher.published',
        originalTopic,
        failureReason,
        attempts,
        correlationId: resolvedCorrelationId,
      });
    } catch (error) {
      this.metrics.dlqPublishFailedTotal.inc();
      this.logger.error('dlq-publisher.publish-failed', {
        action: 'dlq-publisher.publish-failed',
        originalTopic,
        failureReason,
        correlationId: resolvedCorrelationId,
        error: (error as Error).message,
      });
    }
  }

  private fallbackId(): string {
    const id = randomUUID();
    this.logger.warn('dlq-publisher.no-correlation-id', {
      action: 'dlq-publisher.no-correlation-id',
      generatedCorrelationId: id,
    });
    return id;
  }
}
