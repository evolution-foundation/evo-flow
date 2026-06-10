/**
 * Transient error for a batch that could not acquire a rate-limit token after
 * the soft-backpressure retries (story 4.4 / EVO-1218). Deliberately NOT a
 * `TerminalError`: the consumer's ack policy maps it to `nack(requeue=true)`,
 * re-queueing the page so it dispatches once the bucket refills. The
 * redelivery is safe — tabular idempotency skips contacts already SENT.
 */
export class RateLimitedError extends Error {
  readonly inboxId: string;

  constructor(inboxId: string, attempts: number) {
    super(
      `Rate limit on inbox ${inboxId} not released after ${attempts} attempts`,
    );
    this.inboxId = inboxId;
  }
}
