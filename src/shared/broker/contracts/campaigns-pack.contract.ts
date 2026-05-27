import { z } from 'zod';

export const CAMPAIGNS_PACK_TOPIC = 'campaigns.pack';

export const campaignsPackSchema = z.object({
  campaignId: z.string().min(1),
  triggeredAt: z.iso.datetime({ offset: true }),
  triggeredBy: z.string().min(1),
  correlationId: z.string().uuid(),
});

export type CampaignsPackContract = z.infer<typeof campaignsPackSchema>;

export function isCampaignsPackContract(
  payload: unknown,
): payload is CampaignsPackContract {
  return campaignsPackSchema.safeParse(payload).success;
}
