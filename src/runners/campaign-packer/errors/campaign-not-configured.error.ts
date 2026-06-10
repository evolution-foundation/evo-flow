import { TerminalError } from '../../../shared/errors/terminal-error';

/**
 * Terminal error for a campaign whose audience resolved but which is missing
 * the channel type or a message template required to build a `campaigns.send`
 * message. The misconfiguration is permanent, so the consumer drops it
 * (nack requeue=false) instead of looping.
 */
export class CampaignNotConfiguredError extends TerminalError {
  readonly campaignId: string;

  constructor(campaignId: string, reason: string) {
    super(`Campaign ${campaignId} is not dispatchable: ${reason}`);
    this.campaignId = campaignId;
  }
}
