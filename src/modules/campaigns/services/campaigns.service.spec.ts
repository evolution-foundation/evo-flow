import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import {
  CAMPAIGNS_CONTROL_TOPIC,
  isCampaignsControlContract,
} from '../../../shared/broker/contracts/campaigns-control.contract';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * EVO-1222 [4.8]: the status-transition methods publish the fast-path
 * `campaigns.control` event after writing the authoritative Postgres flag.
 */
describe('CampaignsService — campaigns.control publishing', () => {
  let service: CampaignsService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let broker: { publish: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((c: Campaign) => Promise.resolve(c)),
    };
    broker = { publish: jest.fn() };
    const db = { getRepository: jest.fn().mockReturnValue(repo) };
    service = new CampaignsService(db as any, broker as any);
  });

  const seed = (status: CampaignStatus) =>
    repo.findOne.mockResolvedValueOnce({ id: 'camp-1', status } as Campaign);

  const lastControl = (): [string, unknown] =>
    broker.publish.mock.calls.at(-1) as [string, unknown];

  it('AC1: pause publishes a contract-valid pause control event after persisting PAUSED', async () => {
    seed(CampaignStatus.SENDING);

    await service.pause('camp-1');

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.PAUSED }),
    );
    const [topic, payload] = lastControl();
    expect(topic).toBe(CAMPAIGNS_CONTROL_TOPIC);
    expect(payload).toMatchObject({ campaignId: 'camp-1', action: 'pause' });
    expect(isCampaignsControlContract(payload)).toBe(true);
  });

  it('AC3: resume publishes a contract-valid resume control event', async () => {
    seed(CampaignStatus.PAUSED);

    await service.resume('camp-1');

    const [topic, payload] = lastControl();
    expect(topic).toBe(CAMPAIGNS_CONTROL_TOPIC);
    expect(payload).toMatchObject({ campaignId: 'camp-1', action: 'resume' });
    expect(isCampaignsControlContract(payload)).toBe(true);
  });

  it('AC4: stop publishes a contract-valid stop control event', async () => {
    seed(CampaignStatus.SENDING);

    await service.stop('camp-1');

    const [topic, payload] = lastControl();
    expect(topic).toBe(CAMPAIGNS_CONTROL_TOPIC);
    expect(payload).toMatchObject({ campaignId: 'camp-1', action: 'stop' });
    expect(isCampaignsControlContract(payload)).toBe(true);
  });

  // Regression for the review HIGH: the correlationId must be a freshly minted
  // UUID v4 (which the z.uuidv4() contract — and therefore both consumers —
  // accepts), NOT the request CLS id, which SAFE_CORRELATION_ID may preserve as
  // a non-v4 token that both consumers would reject as malformed.
  it('mints a fresh uuid v4 correlationId the consumers accept', async () => {
    seed(CampaignStatus.SENDING);

    await service.pause('camp-1');

    const [, payload] = lastControl();
    const { correlationId } = payload as { correlationId: string };
    expect(correlationId).toMatch(UUID_V4);
    expect(isCampaignsControlContract(payload)).toBe(true);
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
