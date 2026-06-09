/**
 * Marker base class for errors that represent a PERMANENT, non-retriable
 * failure. A broker consumer using `processWithAckPolicy` maps any
 * `TerminalError` (and its subclasses) to `nack(requeue=false)` — a terminal
 * drop — while every other error requeues for redelivery.
 *
 * Subclass it at the boundary where the "this can never succeed on retry"
 * knowledge lives (malformed payload, invalid audience config, deterministic DB
 * error). New terminal types extend the taxonomy without touching any
 * consumer's ack/nack policy.
 */
export class TerminalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
