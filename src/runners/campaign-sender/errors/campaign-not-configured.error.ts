import { TerminalError } from '../../../shared/errors/terminal-error';

/**
 * Terminal error for a `campaigns.send` message that can never be dispatched
 * because the campaign is missing required configuration (no inboxId, message
 * template deleted). Redelivery cannot fix it, so the consumer drops the
 * message to the DLQ; contacts stay PENDING for a manual re-publish once the
 * configuration is repaired.
 */
export class CampaignNotConfiguredError extends TerminalError {
  readonly campaignId: string;

  constructor(campaignId: string, reason: string) {
    super(`Campaign ${campaignId} is not dispatchable: ${reason}`);
    this.campaignId = campaignId;
  }
}
