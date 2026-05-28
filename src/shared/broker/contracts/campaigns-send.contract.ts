import { z } from 'zod';

export const CAMPAIGNS_SEND_TOPIC = 'campaigns.send';

export const CAMPAIGN_CHANNEL_TYPES = ['whatsapp', 'email', 'sms'] as const;
export type CampaignChannelType = (typeof CAMPAIGN_CHANNEL_TYPES)[number];

export const campaignsSendSchema = z
  .object({
    campaignId: z.string().min(1),
    page: z.number().int().positive(),
    totalPages: z.number().int().positive(),
    contactIds: z.array(z.string().min(1)).nonempty(),
    templateId: z.string().min(1),
    channelType: z.enum(CAMPAIGN_CHANNEL_TYPES),
    packKey: z.string().min(1).optional(),
    correlationId: z.uuidv4(),
  })
  .strict()
  .refine((data) => data.page <= data.totalPages, {
    message: 'page must be ≤ totalPages',
    path: ['page'],
  });

export type CampaignsSendContract = z.infer<typeof campaignsSendSchema>;

export function isCampaignsSendContract(
  payload: unknown,
): payload is CampaignsSendContract {
  return campaignsSendSchema.safeParse(payload).success;
}
