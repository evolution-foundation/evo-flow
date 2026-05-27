import { z } from 'zod';

export const CAMPAIGNS_CONTROL_TOPIC = 'campaigns.control';

export const CAMPAIGN_CONTROL_ACTIONS = ['pause', 'stop', 'resume'] as const;
export type CampaignControlAction = (typeof CAMPAIGN_CONTROL_ACTIONS)[number];

export const campaignsControlSchema = z
  .object({
    campaignId: z.string().min(1),
    action: z.enum(CAMPAIGN_CONTROL_ACTIONS),
    correlationId: z.uuidv4(),
  })
  .strict();

export type CampaignsControlContract = z.infer<typeof campaignsControlSchema>;

export function isCampaignsControlContract(
  payload: unknown,
): payload is CampaignsControlContract {
  return campaignsControlSchema.safeParse(payload).success;
}
