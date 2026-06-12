import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { CAMPAIGNS_CONTROL_TOPIC } from '../../../shared/broker/contracts/campaigns-control.contract';

/**
 * EVO-1222 [4.8]: the status-transition methods publish the fast-path
 * `campaigns.control` event after writing the authoritative Postgres flag.
 */
describe('CampaignsService — campaigns.control publishing', () => {
  let service: CampaignsService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let broker: { publish: jest.Mock };
  let correlation: {
    getCorrelationId: jest.Mock;
    resolveIncoming: jest.Mock;
  };

  const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((c: Campaign) => Promise.resolve(c)),
    };
    broker = { publish: jest.fn() };
    correlation = {
      getCorrelationId: jest.fn().mockReturnValue(CORRELATION_ID),
      resolveIncoming: jest.fn().mockReturnValue(CORRELATION_ID),
    };
    const db = { getRepository: jest.fn().mockReturnValue(repo) };
    service = new CampaignsService(db as any, broker as any, correlation as any);
  });

  const seed = (status: CampaignStatus) =>
    repo.findOne.mockResolvedValueOnce({ id: 'camp-1', status } as Campaign);

  it('AC1: pause publishes a pause control event after persisting PAUSED', async () => {
    seed(CampaignStatus.SENDING);

    await service.pause('camp-1');

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.PAUSED }),
    );
    expect(broker.publish).toHaveBeenCalledWith(CAMPAIGNS_CONTROL_TOPIC, {
      campaignId: 'camp-1',
      action: 'pause',
      correlationId: CORRELATION_ID,
    });
  });

  it('AC3: resume publishes a resume control event', async () => {
    seed(CampaignStatus.PAUSED);

    await service.resume('camp-1');

    expect(broker.publish).toHaveBeenCalledWith(CAMPAIGNS_CONTROL_TOPIC, {
      campaignId: 'camp-1',
      action: 'resume',
      correlationId: CORRELATION_ID,
    });
  });

  it('AC4: stop publishes a stop control event', async () => {
    seed(CampaignStatus.SENDING);

    await service.stop('camp-1');

    expect(broker.publish).toHaveBeenCalledWith(CAMPAIGNS_CONTROL_TOPIC, {
      campaignId: 'camp-1',
      action: 'stop',
      correlationId: CORRELATION_ID,
    });
  });

  it('does not publish when the transition is rejected', async () => {
    seed(CampaignStatus.DRAFT); // pause requires SENDING

    await expect(service.pause('camp-1')).rejects.toThrow();
    expect(broker.publish).not.toHaveBeenCalled();
  });

  it('does not fail the transition when the fast-path publish throws (authoritative flag already persisted)', async () => {
    seed(CampaignStatus.SENDING);
    broker.publish.mockRejectedValueOnce(new Error('broker unavailable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await service.pause('camp-1');

    expect(result).toEqual(
      expect.objectContaining({ status: CampaignStatus.PAUSED }),
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
