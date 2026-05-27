import { z } from 'zod';

export const CAMPAIGNS_TRACKED_TOPIC = 'campaigns.tracked';

export const campaignsTrackedSchema = z
  .object({
    campaignId: z.string().min(1),
    page: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    completed: z.boolean(),
    correlationId: z.uuidv4(),
  })
  .strict();

export type CampaignsTrackedContract = z.infer<typeof campaignsTrackedSchema>;

export function isCampaignsTrackedContract(
  payload: unknown,
): payload is CampaignsTrackedContract {
  return campaignsTrackedSchema.safeParse(payload).success;
}
