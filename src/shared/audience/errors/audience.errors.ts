import { TerminalError } from '../../errors/terminal-error';

/**
 * Invalid audience/segment configuration: empty or malformed segment SQL,
 * forbidden keyword, missing `id` column, unknown query type, or a missing
 * segment. Deterministic by nature — the same campaign config fails identically
 * on every retry — so it is terminal.
 */
export class AudienceConfigError extends TerminalError {}

/**
 * A deterministic database failure raised while computing a campaign audience
 * (e.g. malformed segment SQL rejected by Postgres). Wraps the originating
 * driver error so the consumer drops the message terminally instead of looping.
 */
export class DeterministicAudienceError extends TerminalError {
  readonly campaignId: string;

  constructor(campaignId: string, cause: unknown) {
    super(
      `Deterministic audience computation failure for campaign ${campaignId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.campaignId = campaignId;
  }
}
