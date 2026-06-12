import { CampaignPackerService } from './campaign-packer.service';
import { PaginationService } from './pagination.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import {
  AudienceConfigError,
  DeterministicAudienceError,
} from '../../../shared/audience/errors/audience.errors';
import { TerminalError } from '../../../shared/errors/terminal-error';
import { CampaignContact } from '../../../modules/campaigns/entities/campaign-contact.entity';
import type { CampaignsPackContract } from '../../../shared/broker/contracts/campaigns-pack.contract';
import {
  CAMPAIGNS_SEND_TOPIC,
  isCampaignsSendContract,
} from '../../../shared/broker/contracts/campaigns-send.contract';
import { CAMPAIGNS_TRACKED_TOPIC } from '../../../shared/broker/contracts/campaigns-tracked.contract';

const payload: CampaignsPackContract = {
  campaignId: 'camp-1',
  triggeredAt: '2026-06-09T00:00:00.000Z',
  triggeredBy: 'schedule',
  correlationId: '11111111-1111-4111-8111-111111111111',
};

const contactRows = (n: number): Array<{ contactId: string }> =>
  Array.from({ length: n }, (_, i) => ({ contactId: `contact-${i + 1}` }));

const sendCalls = (publish: jest.Mock): unknown[][] =>
  publish.mock.calls.filter(([topic]) => topic === CAMPAIGNS_SEND_TOPIC);

describe('CampaignPackerService', () => {
  let service: CampaignPackerService;
  let findOne: jest.Mock;
  let find: jest.Mock;
  let publish: jest.Mock;
  let computeAudience: jest.Mock;
  let log: jest.Mock;
  let warn: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn();
    find = jest.fn().mockResolvedValue([]);
    publish = jest.fn().mockResolvedValue(undefined);
    computeAudience = jest.fn();
    log = jest.fn();
    warn = jest.fn();
    const db = {
      getRepository: (entity: unknown) =>
        entity === CampaignContact ? { find } : { findOne },
    } as any;
    const audience = { computeAudience } as any;
    const logger = { log, warn, error: jest.fn() } as any;
    const broker = { publish } as any;
    service = new CampaignPackerService(
      db,
      audience,
      logger,
      broker,
      new PaginationService(),
    );
  });

  it('loads the campaign, computes audience and logs audienceSize', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [{ messageTemplateId: 'tmpl-1', variant: 'A' }],
    });
    computeAudience.mockResolvedValueOnce({
      campaignId: 'camp-1',
      totalContacts: 2,
      validContacts: 2,
      invalidContacts: 0,
      processingTimeMs: 10,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(2));

    const result = await service.pack(payload);

    expect(computeAudience).toHaveBeenCalledWith('camp-1');
    expect(result).toEqual({ audienceSize: 2 });
    expect(log).toHaveBeenCalledWith(
      'campaign.packed',
      expect.objectContaining({ campaignId: 'camp-1', audienceSize: 2 }),
    );
  });

  it('paginates the audience and publishes one campaigns.send per page (AC3)', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [{ messageTemplateId: 'tmpl-1', variant: 'A' }],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 1500,
      validContacts: 1500,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(1500));

    await service.pack(payload);

    const calls = sendCalls(publish);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      page: 1,
      totalPages: 2,
      channelType: 'email',
      templateId: 'tmpl-1',
      correlationId: payload.correlationId,
    });
    expect((calls[0][1] as { contactIds: string[] }).contactIds).toHaveLength(
      1000,
    );
    expect(calls[1][1]).toMatchObject({ page: 2, totalPages: 2 });
    expect((calls[1][1] as { contactIds: string[] }).contactIds).toHaveLength(
      500,
    );
  });

  it('EVO-1222 [4.8]: stops publishing pages once the campaign is flagged aborted mid-pagination', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [{ messageTemplateId: 'tmpl-1', variant: 'A' }],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 1500,
      validContacts: 1500,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(1500)); // 2 pages @ batch 1000

    // A pause/stop control message lands right after the first page is queued.
    publish.mockImplementation((topic: string) => {
      if (topic === CAMPAIGNS_SEND_TOPIC) {
        service.markPaginationAborted('camp-1');
      }
      return Promise.resolve();
    });

    await service.pack(payload);

    expect(sendCalls(publish)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'campaign.pagination_aborted',
      expect.objectContaining({ campaignId: 'camp-1' }),
    );
  });

  it('publishes campaigns.tracked completed and warns on empty audience (AC2)', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 0,
      validContacts: 0,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce([]);

    await service.pack(payload);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      CAMPAIGNS_TRACKED_TOPIC,
      expect.objectContaining({
        campaignId: 'camp-1',
        page: 0,
        sentCount: 0,
        failedCount: 0,
        completed: true,
        correlationId: payload.correlationId,
      }),
    );
    expect(warn).toHaveBeenCalledWith('campaign has no contacts', {
      campaignId: 'camp-1',
    });
    expect(sendCalls(publish)).toHaveLength(0);
  });

  it('emits a payload that satisfies the campaigns.send contract and maps channelType (AC4)', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Whatsapp',
      templates: [{ messageTemplateId: 'tmpl-9', variant: 'A' }],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 3,
      validContacts: 3,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(3));

    await service.pack(payload);

    const [, message] = sendCalls(publish)[0];
    expect(isCampaignsSendContract(message)).toBe(true);
    expect(message).toMatchObject({
      channelType: 'whatsapp',
      templateId: 'tmpl-9',
      page: 1,
      totalPages: 1,
    });
  });

  it('prefers the A-variant template when multiple templates exist', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [
        { messageTemplateId: 'tmpl-b', variant: 'B' },
        { messageTemplateId: 'tmpl-a', variant: 'A' },
      ],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 1,
      validContacts: 1,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(1));

    await service.pack(payload);

    expect(sendCalls(publish)[0][1]).toMatchObject({ templateId: 'tmpl-a' });
  });

  it('throws a terminal CampaignNotConfiguredError when no template exists', async () => {
    findOne.mockResolvedValueOnce({
      id: 'camp-1',
      channelType: 'Channel::Email',
      templates: [],
    });
    computeAudience.mockResolvedValueOnce({
      totalContacts: 2,
      validContacts: 2,
      invalidContacts: 0,
      strategy: 'segment',
    });
    find.mockResolvedValueOnce(contactRows(2));

    const err = await service.pack(payload).catch((e) => e);
    expect(err).toBeInstanceOf(CampaignNotConfiguredError);
    expect(err).toBeInstanceOf(TerminalError);
    expect(sendCalls(publish)).toHaveLength(0);
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
