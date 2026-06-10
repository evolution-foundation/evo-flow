import { TerminalError } from '../../../shared/errors/terminal-error';

/**
 * Terminal error for a `campaigns.send` message whose `campaignId` does not
 * resolve to a Campaign row. The consumer maps it to `nack(requeue=false)` —
 * requeueing would loop forever since the campaign will never appear.
 */
export class CampaignNotFoundError extends TerminalError {
  readonly campaignId: string;

  constructor(campaignId: string) {
    super(`Campaign ${campaignId} not found`);
    this.campaignId = campaignId;
  }
}
