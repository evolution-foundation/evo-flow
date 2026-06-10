import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  EventsReceivedContract,
  isEventsReceivedContract,
} from 'src/shared/broker/contracts/events-received.contract';
import { TerminalError } from 'src/shared/errors/terminal-error';
import { IdempotencyService } from 'src/shared/idempotency/idempotency.service';
import { SignatureValidatorRegistry } from './signature-validator.registry';
import { EnricherService } from './enricher.service';
import { ClickHouseWriterService } from './clickhouse-writer.service';
import { EventProcessMetrics } from '../metrics/event-process-metrics';

/**
 * Thrown when a consumed message is not a valid `events.received` envelope.
 * It is a permanent (non-retriable) failure — the consumer must drop it
 * (terminal nack) rather than requeue, or it would redeliver forever.
 */
export class InvalidEnvelopeError extends TerminalError {}

/**
 * Handler for the webhook event pipeline (story 3.3 / EVO-1208).
 *
 * Validates the inbound `events.received.<platform>` envelope, verifies the
 * provider signature (3.4), drops duplicates via the shared idempotency guard
 * (3.5), enriches the event (3.6) and hands it to the micro-batching
 * ClickHouse writer (3.7). Throws on a malformed envelope so the consumer can
 * nack/redeliver rather than silently dropping a message.
 */
@Injectable()
export class EventProcessService {
  private readonly logger = new CustomLoggerService(EventProcessService.name);

  constructor(
    private readonly validators: SignatureValidatorRegistry,
    private readonly metrics: EventProcessMetrics,
    private readonly idempotency: IdempotencyService,
    private readonly enricher: EnricherService,
    private readonly writer: ClickHouseWriterService,
  ) {}

  async handle(envelope: unknown): Promise<void> {
    if (!isEventsReceivedContract(envelope)) {
      throw new InvalidEnvelopeError(
        'event-process received a payload that is not a valid events.received envelope',
      );
    }
    const valid: EventsReceivedContract = envelope;

    if (!(await this.hasValidSignature(valid))) return;

    if (await this.isDuplicate(valid)) return;

    const enriched = await this.enricher.enrich(valid);
    this.writer.enqueue(enriched);

    this.logger.log('event-process.handle', {
      action: 'event-process.handle',
      platform: valid.platform,
      correlationId: valid.correlationId,
      ingestionId: valid.ingestionId,
      rawPayloadBytes: Buffer.byteLength(
        JSON.stringify(valid.rawPayload ?? null),
      ),
    });
  }

  /**
   * Resolves the provider's signature validator and runs it. Returns false —
   * meaning "drop, but ack" — when no validator is registered for the platform
   * (e.g. `unknown`) or the signature does not verify. Dropping is a plain
   * `return` upstream, never a throw, so the broker acks and never redelivers a
   * payload we have already rejected.
   */
  private async hasValidSignature(
    valid: EventsReceivedContract,
  ): Promise<boolean> {
    const validator = this.validators.for(valid.platform);
    if (!validator) {
      this.logger.warn('event-process.signature.no-validator', {
        action: 'event-process.signature.no-validator',
        platform: valid.platform,
        correlationId: valid.correlationId,
        ingestionId: valid.ingestionId,
      });
      this.metrics.signatureInvalid.inc({
        platform: valid.platform,
        reason: 'no_validator',
      });
      return false;
    }

    // HMAC validators need the exact bytes the provider signed. The receiver
    // (story 3.1) preserves rawPayload as the raw UTF-8 string; a non-string
    // here means an upstream change broke that invariant and HMAC checks would
    // silently fail, so surface it loudly.
    if (typeof valid.rawPayload !== 'string') {
      this.logger.warn('event-process.signature.non-string-payload', {
        action: 'event-process.signature.non-string-payload',
        platform: valid.platform,
        correlationId: valid.correlationId,
        ingestionId: valid.ingestionId,
      });
    }

    if (await validator.validate(this.rawPayloadString(valid), valid.headers)) {
      return true;
    }

    this.logger.warn('event-process.signature.invalid', {
      action: 'event-process.signature.invalid',
      platform: valid.platform,
      correlationId: valid.correlationId,
      ingestionId: valid.ingestionId,
    });
    this.metrics.signatureInvalid.inc({
      platform: valid.platform,
      reason: 'invalid_signature',
    });
    return false;
  }

  /**
   * Drops a webhook the pipeline has already processed within the idempotency
   * TTL. Runs AFTER signature validation so forged payloads never reach Redis.
   * The hash covers only `rawPayload` (per story 3.5) — folding in headers or
   * metadata would mask legitimate duplicates that arrive with a different
   * header. A duplicate is expected behaviour, so it logs at info, not warn.
   */
  private async isDuplicate(valid: EventsReceivedContract): Promise<boolean> {
    const hash = this.idempotency.computeHash(this.rawPayloadString(valid));
    if (await this.idempotency.checkAndMark(hash)) return false;

    this.logger.log('event-process.duplicate', {
      action: 'event-process.duplicate',
      platform: valid.platform,
      correlationId: valid.correlationId,
      ingestionId: valid.ingestionId,
    });
    this.metrics.eventDuplicatesDropped.inc({ platform: valid.platform });
    return true;
  }

  private rawPayloadString(valid: EventsReceivedContract): string {
    return typeof valid.rawPayload === 'string'
      ? valid.rawPayload
      : JSON.stringify(valid.rawPayload ?? '');
  }
}
