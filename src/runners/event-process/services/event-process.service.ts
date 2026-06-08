import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  EventsReceivedContract,
  isEventsReceivedContract,
} from 'src/shared/broker/contracts/events-received.contract';

/**
 * Thrown when a consumed message is not a valid `events.received` envelope.
 * It is a permanent (non-retriable) failure — the consumer must drop it
 * (terminal nack) rather than requeue, or it would redeliver forever.
 */
export class InvalidEnvelopeError extends Error {}

/**
 * Stub handler for the webhook event pipeline (story 3.3 / EVO-1208).
 *
 * Validates the inbound `events.received.<platform>` envelope and logs it. The
 * real pipeline — signature validation (3.4), idempotency (3.5), enrichment
 * (3.6) and ClickHouse persist (3.7) — replaces this body in later stories.
 * Throws on a malformed envelope so the consumer can nack/redeliver rather than
 * silently dropping a message.
 */
@Injectable()
export class EventProcessService {
  private readonly logger = new CustomLoggerService(EventProcessService.name);

  async handle(envelope: unknown): Promise<void> {
    if (!isEventsReceivedContract(envelope)) {
      throw new InvalidEnvelopeError(
        'event-process received a payload that is not a valid events.received envelope',
      );
    }
    const valid: EventsReceivedContract = envelope;

    this.logger.log('event-process.handle', {
      action: 'event-process.handle',
      platform: valid.platform,
      correlationId: valid.correlationId,
      ingestionId: valid.ingestionId,
      rawPayloadBytes: Buffer.byteLength(
        JSON.stringify(valid.rawPayload ?? null),
      ),
    });

    return Promise.resolve();
  }
}
