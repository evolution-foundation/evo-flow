import { CampaignSenderService } from './campaign-sender.service';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import {
  Campaign,
  CampaignStatus,
} from '../../../modules/campaigns/entities/campaign.entity';
import {
  CampaignContact,
  CampaignContactStatus,
} from '../../../modules/campaigns/entities/campaign-contact.entity';
import type { CampaignsSendContract } from '../../../shared/broker/contracts/campaigns-send.contract';
import type { ContactDto } from '../../../shared/crm-client/types/contact';

const CAMPAIGN_ID = 'camp-1';

const payload = (contactIds: [string, ...string[]]): CampaignsSendContract => ({
  campaignId: CAMPAIGN_ID,
  page: 1,
  totalPages: 1,
  contactIds,
  templateId: 'tpl-1',
  channelType: 'whatsapp',
  correlationId: '11111111-1111-4111-8111-111111111111',
});

const campaign = (status = CampaignStatus.SENDING): Campaign =>
  ({ id: CAMPAIGN_ID, status, inboxId: 'inbox-1' }) as Campaign;

const row = (
  contactId: string,
  status = CampaignContactStatus.PENDING,
): CampaignContact =>
  ({
    id: `cc-${contactId}`,
    campaignId: CAMPAIGN_ID,
    contactId,
    status,
  }) as CampaignContact;

const dto = (id: string, blocked = false): ContactDto =>
  ({ id, name: `Contact ${id}`, blocked }) as unknown as ContactDto;

describe('CampaignSenderService', () => {
  let service: CampaignSenderService;
  let campaignFindOne: jest.Mock;
  let contactFind: jest.Mock;
  let contactUpdate: jest.Mock;
  let findByIds: jest.Mock;
  let findById: jest.Mock;
  let loadTemplate: jest.Mock;
  let dispatch: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let metrics: { incError: jest.Mock; incThroughput: jest.Mock };

  const template = { id: 'tpl-1', name: 'welcome' };

  beforeEach(() => {
    campaignFindOne = jest.fn();
    contactFind = jest.fn();
    contactUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    findByIds = jest.fn().mockResolvedValue([]);
    findById = jest.fn().mockResolvedValue(null);
    loadTemplate = jest.fn().mockResolvedValue(template);
    dispatch = jest.fn().mockResolvedValue({
      kind: 'sent',
      result: { success: true, latencyMs: 5 },
    });
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    metrics = { incError: jest.fn(), incThroughput: jest.fn() };

    const db = {
      getRepository: (entity: unknown) =>
        entity === Campaign
          ? { findOne: campaignFindOne }
          : { find: contactFind, update: contactUpdate },
    };

    service = new CampaignSenderService(
      db as any,
      { findByIds, findById } as any,
      logger as any,
      metrics as any,
      { loadTemplate, dispatch } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC1: dispatches every PENDING contact and marks each SENT with sentAt', async () => {
    const ids: [string, ...string[]] = ['c1', 'c2', 'c3'];
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue(ids.map((id) => row(id)));
    findByIds.mockResolvedValue(ids.map((id) => dto(id)));

    const result = await service.send(payload(ids));

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(contactUpdate).toHaveBeenCalledTimes(3);
    for (const id of ids) {
      expect(contactUpdate).toHaveBeenCalledWith(
        { id: `cc-${id}`, status: CampaignContactStatus.PENDING },
        {
          status: CampaignContactStatus.SENT,
          sentAt: expect.any(Date) as Date,
        },
      );
    }
    expect(metrics.incThroughput).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      dispatched: 3,
      skipped: 0,
      failed: 0,
      aborted: false,
    });
  });

  it('AC2: skips an already-SENT contact with the canonical log line', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([
      row('c1', CampaignContactStatus.SENT),
      row('c2'),
    ]);
    findByIds.mockResolvedValue([dto('c1'), dto('c2')]);

    const result = await service.send(payload(['c1', 'c2']));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      'skipped: already sent',
      expect.objectContaining({ contactId: 'c1' }),
    );
    // Only the still-PENDING contact is hydrated from the CRM (NFR16).
    expect(findByIds).toHaveBeenCalledWith(['c2']);
    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(1);
  });

  it('dispatches a duplicated contactId only once', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1')]);

    const result = await service.send(payload(['c1', 'c1', 'c1']));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('AC3: aborts mid-batch when the campaign flips to Paused after the status cache expires', async () => {
    campaignFindOne
      .mockResolvedValueOnce(campaign(CampaignStatus.SENDING))
      .mockResolvedValue({ id: CAMPAIGN_ID, status: CampaignStatus.PAUSED });
    contactFind.mockResolvedValue([row('c1'), row('c2')]);
    findByIds.mockResolvedValue([dto('c1'), dto('c2')]);

    // First contact reads the warm cache; expire it before the second.
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    dispatch.mockImplementation(() => {
      now += 6_000;
      return Promise.resolve({
        kind: 'sent',
        result: { success: true, latencyMs: 5 },
      });
    });

    const result = await service.send(payload(['c1', 'c2']));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'aborted: campaign paused',
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
    expect(result).toEqual({
      dispatched: 1,
      skipped: 0,
      failed: 0,
      aborted: true,
    });
  });

  it('AC4: marks the contact FAILED on a 4xx dispatch and logs the reason', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1')]);
    dispatch.mockResolvedValue({
      kind: 'failed',
      reason: 'http_4xx: 422',
      statusCode: 422,
      result: { success: false, statusCode: 422, latencyMs: 5 },
    });

    const result = await service.send(payload(['c1']));

    expect(contactUpdate).toHaveBeenCalledWith(
      { id: 'cc-c1', status: CampaignContactStatus.PENDING },
      { status: CampaignContactStatus.FAILED },
    );
    expect(logger.error).toHaveBeenCalledWith(
      'campaign contact failed',
      expect.objectContaining({
        contactId: 'c1',
        statusCode: 422,
        reason: 'http_4xx: 422',
      }),
    );
    expect(metrics.incError).toHaveBeenCalledWith('dispatch_4xx');
    expect(result.failed).toBe(1);
  });

  it('marks FAILED with dispatch_5xx category when the retry policy exhausts (4.5)', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1')]);
    dispatch.mockResolvedValue({
      kind: 'failed',
      reason: 'dispatch_exhausted_retries: ["503","503","503","503"]',
      statusCode: 503,
      result: { success: false, statusCode: 503, latencyMs: 5 },
    });

    const result = await service.send(payload(['c1']));

    expect(metrics.incError).toHaveBeenCalledWith('dispatch_5xx');
    expect(logger.error).toHaveBeenCalledWith(
      'campaign contact failed',
      expect.objectContaining({
        reason: 'dispatch_exhausted_retries: ["503","503","503","503"]',
      }),
    );
    expect(result.failed).toBe(1);
  });

  it('AC4 (4.5): an aborted retry leaves the contact PENDING and ends the page as aborted', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1'), row('c2')]);
    findByIds.mockResolvedValue([dto('c1'), dto('c2')]);
    dispatch.mockResolvedValue({ kind: 'aborted', abortReason: 'stopped' });

    const result = await service.send(payload(['c1', 'c2']));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(contactUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      dispatched: 0,
      skipped: 0,
      failed: 0,
      aborted: true,
    });
  });

  it('hands the dispatcher an abort probe that reflects the campaign status', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1')]);

    await service.send(payload(['c1']));

    const [[input]] = dispatch.mock.calls as [
      [{ shouldAbort: () => Promise<'paused' | 'stopped' | null> }],
    ];
    await expect(input.shouldAbort()).resolves.toBeNull();

    // Expire the TTL cache and flip the campaign: the probe must see it.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 6_000);
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: CampaignStatus.STOPPED,
    });
    await expect(input.shouldAbort()).resolves.toBe('stopped');
  });

  it('throws terminal CampaignNotFoundError when the campaign does not exist', async () => {
    campaignFindOne.mockResolvedValue(null);

    await expect(service.send(payload(['c1']))).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  it('throws terminal CampaignNotConfiguredError when the campaign has no inbox', async () => {
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: CampaignStatus.SENDING,
      inboxId: null,
    });

    await expect(service.send(payload(['c1']))).rejects.toThrow(
      CampaignNotConfiguredError,
    );
  });

  it('aborts upfront without loading the template when the campaign is already Paused', async () => {
    campaignFindOne.mockResolvedValue(campaign(CampaignStatus.PAUSED));

    const result = await service.send(payload(['c1']));

    expect(result.aborted).toBe(true);
    expect(loadTemplate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails a contact that the CRM confirms missing (404 on direct lookup)', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([]);
    findById.mockResolvedValue(null);

    const result = await service.send(payload(['c1']));

    expect(findById).toHaveBeenCalledWith('c1');
    expect(metrics.incError).toHaveBeenCalledWith('contact_not_found');
    expect(result.failed).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('propagates a transient CRM error on direct lookup so the batch requeues', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([]);
    findById.mockRejectedValue(new Error('CRM unavailable'));

    await expect(service.send(payload(['c1']))).rejects.toThrow(
      'CRM unavailable',
    );
    expect(contactUpdate).not.toHaveBeenCalled();
  });

  it('skips a blocked contact as SKIPPED without dispatching', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1', true)]);

    const result = await service.send(payload(['c1']));

    expect(dispatch).not.toHaveBeenCalled();
    expect(contactUpdate).toHaveBeenCalledWith(
      { id: 'cc-c1', status: CampaignContactStatus.PENDING },
      { status: CampaignContactStatus.SKIPPED },
    );
    expect(result.skipped).toBe(1);
  });

  it('counts a lost claim race as skipped when the conditional SENT update hits 0 rows', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([row('c1')]);
    findByIds.mockResolvedValue([dto('c1')]);
    contactUpdate.mockResolvedValue({ affected: 0 });

    const result = await service.send(payload(['c1']));

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'skipped: already sent (lost claim race)',
      expect.objectContaining({ contactId: 'c1' }),
    );
  });

  it('skips ids without a campaign_contact row', async () => {
    campaignFindOne.mockResolvedValue(campaign());
    contactFind.mockResolvedValue([]);
    findByIds.mockResolvedValue([dto('c1')]);

    const result = await service.send(payload(['c1']));

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
