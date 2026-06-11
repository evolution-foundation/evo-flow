import { CampaignTrackerService } from './campaign-tracker.service';
import {
  Campaign,
  CampaignStatus,
  CampaignType,
} from '../../../modules/campaigns/entities/campaign.entity';
import { CampaignTemplate } from '../../../modules/campaigns/entities/campaign-template.entity';
import { CampaignTrackedPage } from '../../../modules/campaigns/entities/campaign-tracked-page.entity';
import type { CampaignsTrackedContract } from '../../../shared/broker/contracts/campaigns-tracked.contract';

const CAMPAIGN_ID = 'camp-1';

const tracked = (
  over: Partial<CampaignsTrackedContract> = {},
): CampaignsTrackedContract => ({
  campaignId: CAMPAIGN_ID,
  page: 1,
  sentCount: 5,
  failedCount: 1,
  completed: false,
  correlationId: '11111111-1111-4111-8111-111111111111',
  ...over,
});

describe('CampaignTrackerService', () => {
  let service: CampaignTrackerService;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  let campaignFindOne: jest.Mock;
  let campaignQuery: jest.Mock;
  let campaignUpdateExecute: jest.Mock;
  let trackedInsert: jest.Mock;
  let templateFind: jest.Mock;
  let templateUpdate: jest.Mock;

  // Controls what the completion-check SELECT reports back.
  let aggTotalPages: number | null;
  let aggReported: number;

  beforeEach(() => {
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    campaignFindOne = jest.fn().mockResolvedValue({
      id: CAMPAIGN_ID,
      type: CampaignType.SIMPLE,
      status: CampaignStatus.SENDING,
      testabWinnerCriteria: null,
    });

    aggTotalPages = null;
    aggReported = 0;
    campaignQuery = jest.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('reported')) {
        return Promise.resolve([
          { total_pages: aggTotalPages, reported: aggReported },
        ]);
      }
      return Promise.resolve([]);
    });

    campaignUpdateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: campaignUpdateExecute,
    };

    // First report by default; tests override for the dedup case.
    trackedInsert = jest.fn().mockResolvedValue([{ id: 'page-row' }]);
    templateFind = jest.fn().mockResolvedValue([]);
    templateUpdate = jest.fn().mockResolvedValue({ affected: 1 });

    const db = {
      getRepository: (entity: unknown) => {
        if (entity === Campaign) {
          return {
            findOne: campaignFindOne,
            query: campaignQuery,
            createQueryBuilder: () => qb,
          };
        }
        if (entity === CampaignTrackedPage) {
          return { query: trackedInsert };
        }
        if (entity === CampaignTemplate) {
          return { find: templateFind, update: templateUpdate };
        }
        throw new Error('unexpected entity');
      },
    };

    service = new CampaignTrackerService(db as any, logger as any);
  });

  const incrementCalls = (): unknown[][] =>
    campaignQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('sent_contacts ='),
    ) as unknown[][];

  it('AC1: a first page report folds its counts into the campaign totals (ledger-derived)', async () => {
    await service.record(tracked({ page: 1, sentCount: 5, failedCount: 1 }));

    expect(trackedInsert).toHaveBeenCalled();
    const calls = incrementCalls();
    expect(calls).toHaveLength(1);
    // Counters are recomputed from the ledger SUM, scoped to the campaign.
    expect(calls[0][0]).toContain('SUM(sent_count)');
    expect(calls[0][1]).toEqual([CAMPAIGN_ID]);
    expect(campaignUpdateExecute).not.toHaveBeenCalled();
  });

  it('idempotent: counters derive from the ledger SUM, never read-modify-add', async () => {
    trackedInsert.mockResolvedValueOnce([]); // redelivery → ON CONFLICT no-op

    await service.record(tracked({ page: 1, sentCount: 5 }));

    const calls = incrementCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('SUM(');
    // No additive increment → a redelivered page cannot double-count.
    expect(calls[0][0]).not.toContain('+ $');
  });

  it('AC2: transitions to Completed once every page has reported', async () => {
    aggTotalPages = 3;
    aggReported = 3;

    await service.record(tracked({ page: 3, completed: true }));

    // total_pages learned from the completed page
    expect(campaignQuery).toHaveBeenCalledWith(
      expect.stringContaining('total_pages = $1'),
      [3, CAMPAIGN_ID],
    );
    expect(campaignUpdateExecute).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'campaign.completed',
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it('does not complete while pages are still missing', async () => {
    aggTotalPages = 3;
    aggReported = 2;

    await service.record(tracked({ page: 2, completed: false }));

    expect(campaignUpdateExecute).not.toHaveBeenCalled();
  });

  it('AC4: an empty-audience report (completed page 0) completes immediately', async () => {
    await service.record(
      tracked({ page: 0, sentCount: 0, failedCount: 0, completed: true }),
    );

    expect(trackedInsert).not.toHaveBeenCalled();
    expect(incrementCalls()).toHaveLength(0);
    expect(campaignUpdateExecute).toHaveBeenCalled();
  });

  it('ignores reports for an already-completed campaign', async () => {
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      type: CampaignType.SIMPLE,
      status: CampaignStatus.COMPLETED,
    });

    await service.record(tracked({ page: 1, completed: true }));

    expect(trackedInsert).not.toHaveBeenCalled();
    expect(campaignUpdateExecute).not.toHaveBeenCalled();
  });

  it('drops a report for a campaign that no longer exists', async () => {
    campaignFindOne.mockResolvedValue(null);

    await service.record(tracked());

    expect(trackedInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'tracked: campaign not found',
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it('AC3: selects the A/B winner on completion of a testAB campaign (variant A fallback)', async () => {
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      type: CampaignType.TESTAB,
      status: CampaignStatus.SENDING_TESTAB,
      testabWinnerCriteria: 'sent',
    });
    templateFind.mockResolvedValue([
      { id: 'tpl-a', variant: 'A', statistics: {} },
      { id: 'tpl-b', variant: 'B', statistics: {} },
    ]);
    aggTotalPages = 2;
    aggReported = 2;

    await service.record(tracked({ page: 2, completed: true }));

    // resets all, then sets the chosen variant (A, on empty statistics)
    expect(templateUpdate).toHaveBeenCalledWith(
      { campaignId: CAMPAIGN_ID },
      { isWinner: false },
    );
    expect(templateUpdate).toHaveBeenCalledWith(
      { id: 'tpl-a' },
      { isWinner: true },
    );
    expect(logger.log).toHaveBeenCalledWith(
      'campaign.ab_winner.selected',
      expect.objectContaining({ winnerTemplateId: 'tpl-a', variant: 'A' }),
    );
  });

  it('AC3: picks the variant with the higher score for the configured criteria', async () => {
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      type: CampaignType.TESTAB,
      status: CampaignStatus.SENDING_TESTAB,
      testabWinnerCriteria: 'opened',
    });
    templateFind.mockResolvedValue([
      { id: 'tpl-a', variant: 'A', statistics: { opened: 10 } },
      { id: 'tpl-b', variant: 'B', statistics: { opened: 42 } },
    ]);
    aggTotalPages = 1;
    aggReported = 1;

    await service.record(tracked({ page: 1, completed: true }));

    expect(templateUpdate).toHaveBeenCalledWith(
      { id: 'tpl-b' },
      { isWinner: true },
    );
  });

  it('AC3: a winner-selection failure does not fail the message (campaign already Completed)', async () => {
    campaignFindOne.mockResolvedValue({
      id: CAMPAIGN_ID,
      type: CampaignType.TESTAB,
      status: CampaignStatus.SENDING_TESTAB,
      testabWinnerCriteria: 'sent',
    });
    templateFind.mockRejectedValue(new Error('db down'));
    aggTotalPages = 1;
    aggReported = 1;

    await expect(
      service.record(tracked({ page: 1, completed: true })),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'ab winner selection failed',
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });
});
