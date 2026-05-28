import { z } from 'zod';

export const CAMPAIGNS_PACK_TOPIC = 'campaigns.pack';

export const CAMPAIGN_TRIGGERED_BY_VALUES = [
  'schedule',
  'manual',
  'recurrence',
] as const;
export type CampaignTriggeredBy = (typeof CAMPAIGN_TRIGGERED_BY_VALUES)[number];

export const campaignsPackSchema = z
  .object({
    campaignId: z.string().min(1),
    triggeredAt: z.iso.datetime({ offset: true }),
    triggeredBy: z.enum(CAMPAIGN_TRIGGERED_BY_VALUES),
    correlationId: z.uuidv4(),
  })
  .strict();

export type CampaignsPackContract = z.infer<typeof campaignsPackSchema>;

export function isCampaignsPackContract(
  payload: unknown,
): payload is CampaignsPackContract {
  return campaignsPackSchema.safeParse(payload).success;
}
