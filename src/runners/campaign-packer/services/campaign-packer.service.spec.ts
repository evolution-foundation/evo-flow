import { CampaignPackerService } from './campaign-packer.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import {
  AudienceConfigError,
  DeterministicAudienceError,
} from '../../../shared/audience/errors/audience.errors';
import { TerminalError } from '../../../shared/errors/terminal-error';
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

  it('wraps a deterministic DB error (malformed SQL) as a terminal DeterministicAudienceError', async () => {
    findOne.mockResolvedValueOnce({ id: 'camp-1' });
    const pgError = Object.assign(new Error('syntax error at or near "FROM"'), {
      code: '42601',
    });
    computeAudience.mockRejectedValueOnce(pgError);

    const err = await service.pack(payload).catch((e) => e);
    expect(err).toBeInstanceOf(DeterministicAudienceError);
    expect(err).toBeInstanceOf(TerminalError);
    expect(err.campaignId).toBe('camp-1');
  });

  it('propagates an AudienceConfigError unchanged (already terminal)', async () => {
    findOne.mockResolvedValueOnce({ id: 'camp-1' });
    computeAudience.mockRejectedValueOnce(
      new AudienceConfigError('SQL query is empty'),
    );

    const err = await service.pack(payload).catch((e) => e);
    expect(err).toBeInstanceOf(AudienceConfigError);
    expect(err).not.toBeInstanceOf(DeterministicAudienceError);
  });

  it('rethrows a transient error (connection drop) so the consumer requeues', async () => {
    findOne.mockResolvedValueOnce({ id: 'camp-1' });
    const transient = Object.assign(new Error('connection terminated'), {
      code: '08006',
    });
    computeAudience.mockRejectedValueOnce(transient);

    const err = await service.pack(payload).catch((e) => e);
    expect(err).toBe(transient);
    expect(err).not.toBeInstanceOf(TerminalError);
  });
});
