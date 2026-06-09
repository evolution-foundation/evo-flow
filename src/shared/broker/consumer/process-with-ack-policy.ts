import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { TerminalError } from '../../errors/terminal-error';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';

interface AckPolicyContext {
  logger: CustomLoggerService;
  context: string;
  /** Extra structured fields merged into the failure log (e.g. campaignId). */
  meta?: Record<string, unknown>;
}

/**
 * Shared ack/nack policy for every broker consumer in the pipeline
 * (event-process, campaign-packer, campaign-sender, …). Runs `work`, then:
 *  - success         → `ack`
 *  - `TerminalError`  → `nack(requeue=false)` (permanent drop)
 *  - any other error  → `nack(requeue=true)`  (transient — redeliver)
 *
 * Centralizing this keeps the "what is terminal" decision in the error taxonomy
 * (`TerminalError`) instead of copy-pasted try/catch blocks, so a new consumer
 * gets the correct redelivery behavior for free. The caller is responsible for
 * running this inside its own correlation context.
 */
export async function processWithAckPolicy<T>(
  msg: BrokerMessage<T>,
  broker: IMessageBroker,
  { logger, context, meta }: AckPolicyContext,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
    await broker.ack(msg);
  } catch (err) {
    const terminal = err instanceof TerminalError;
    // Terminal and transient failures both log at `error`; the `terminal` flag
    // distinguishes a permanent drop from a will-retry requeue for alerting.
    logger.error(`${context} processing failed — nack(requeue=${!terminal})`, {
      ...meta,
      terminal,
      messageId: msg.id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await broker.nack(msg, !terminal);
  }
}
