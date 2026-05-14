import { AudienceValidationService } from './audience-validation.service';

describe('AudienceValidationService', () => {
  const campaignRepository: any = {
    findOne: jest.fn(),
  };
  const campaignContactRepository: any = {
    manager: { query: jest.fn() },
  };
  const segmentQueryBuilder: any = {
    analyzeSegmentationStrategy: jest.fn(),
    executeAudienceQuery: jest.fn(),
    validateContactForChannel: jest.fn(),
  };
  const contactsClient: any = {
    findByIds: jest.fn(),
  };

  const service = new AudienceValidationService(
    campaignRepository,
    campaignContactRepository,
    segmentQueryBuilder,
    contactsClient,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validateBeforeComputation handles segment strategy via CPA query', async () => {
    campaignRepository.findOne.mockResolvedValue({
      id: 'camp-1',
      accountId: 'acc-1',
      channelType: 'Channel::Email',
    });
    segmentQueryBuilder.analyzeSegmentationStrategy.mockResolvedValue({
      type: 'segment',
      segmentId: 'seg-1',
    });

    campaignContactRepository.manager.query
      .mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]) // sample ids
      .mockResolvedValueOnce([{ total: 2 }]); // total

    contactsClient.findByIds.mockResolvedValue([
      { id: 'c1', email: 'a@a.com', blocked: false },
      { id: 'c2', email: 'b@b.com', blocked: false },
    ]);
    segmentQueryBuilder.validateContactForChannel.mockReturnValue({
      valid: true,
    });

    const result = await service.validateBeforeComputation('camp-1', 50);

    expect(segmentQueryBuilder.executeAudienceQuery).not.toHaveBeenCalled();
    expect(contactsClient.findByIds).toHaveBeenCalledWith(['c1', 'c2']);
    expect(result.totalContacts).toBe(2);
    expect(result.validContacts).toBe(2);
    expect(result.isValid).toBe(true);
  });
});
