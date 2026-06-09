import { CampaignPackerService } from './campaign-packer.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import type { CampaignsPackContract } from '../../../shared/broker/contracts/campaigns-pack.contract';

const payload: CampaignsPackContract = {
  campaignId: 'camp-1',
  triggeredAt: '2026-06-09T00:00:00.000Z',
  triggeredBy: 'schedule',
  correlationId: '11111111-1111-4111-8111-111111111111',
};

describe('CampaignPackerService', () => {
  let service: CampaignPackerService;
  let findOne: jest.Mock;
  let computeAudience: jest.Mock;
  let log: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn();
    computeAudience = jest.fn();
    log = jest.fn();
    const db = { getRepository: () => ({ findOne }) } as any;
    const audience = { computeAudience } as any;
    const logger = { log, warn: jest.fn(), error: jest.fn() } as any;
    service = new CampaignPackerService(db, audience, logger);
  });

  it('loads the campaign, computes audience and logs audienceSize', async () => {
    findOne.mockResolvedValueOnce({ id: 'camp-1' });
    computeAudience.mockResolvedValueOnce({
      campaignId: 'camp-1',
      totalContacts: 42,
      validContacts: 40,
      invalidContacts: 2,
      processingTimeMs: 10,
      strategy: 'segment',
    });

    const result = await service.pack(payload);

    expect(computeAudience).toHaveBeenCalledWith('camp-1');
    expect(result).toEqual({ audienceSize: 42 });
    expect(log).toHaveBeenCalledWith(
      'campaign.packed',
      expect.objectContaining({ campaignId: 'camp-1', audienceSize: 42 }),
    );
  });

  it('throws CampaignNotFoundError when the campaign does not exist', async () => {
    findOne.mockResolvedValueOnce(null);

    await expect(service.pack(payload)).rejects.toBeInstanceOf(
      CampaignNotFoundError,
    );
    expect(computeAudience).not.toHaveBeenCalled();
  });
});
