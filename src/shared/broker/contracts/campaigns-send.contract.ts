import { z } from 'zod';

export const CAMPAIGNS_SEND_TOPIC = 'campaigns.send';

export const campaignsSendSchema = z.object({
  campaignId: z.string().min(1),
  page: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
  contactIds: z.array(z.string().min(1)),
  templateId: z.string().min(1),
  channelType: z.string().min(1),
  packKey: z.string().min(1).optional(),
  correlationId: z.string().uuid(),
});

export type CampaignsSendContract = z.infer<typeof campaignsSendSchema>;

export function isCampaignsSendContract(
  payload: unknown,
): payload is CampaignsSendContract {
  return campaignsSendSchema.safeParse(payload).success;
}
