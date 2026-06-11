import { NestFactory } from '@nestjs/core';
import { publishCampaignsPack } from './campaign-execution.activities';
import { IMESSAGE_BROKER } from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_PACK_TOPIC,
  CampaignsPackContract,
  isCampaignsPackContract,
} from '../../../shared/broker/contracts/campaigns-pack.contract';

jest.mock('@nestjs/core');
// Stub the app module so booting the activity's Nest context never pulls the
// real application graph (DB, brokers) into the unit test.
jest.mock('../../../app.module', () => ({
  AppModule: { forRoot: () => ({}) },
}));
jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = 'camp-1';

describe('publishCampaignsPack activity', () => {
  // Stable mock references: the activity caches its Nest context as a module
  // singleton, so the broker resolved on the first call is reused. Reconfigure
  // behaviour per test on the same `publish` fn rather than swapping it out.
  const publish = jest.fn();
  const appGet = jest.fn().mockReturnValue({ publish });

  beforeEach(() => {
    publish.mockReset().mockResolvedValue(undefined);
    (NestFactory.createApplicationContext as jest.Mock).mockResolvedValue({
      get: appGet,
    });
  });

  it('publishes one schema-valid campaigns.pack message resolved via the broker token', async () => {
    await publishCampaignsPack({
      campaignId: CAMPAIGN_ID,
      correlationId: CORRELATION_ID,
    });

    expect(appGet).toHaveBeenCalledWith(IMESSAGE_BROKER);
    expect(publish).toHaveBeenCalledTimes(1);

    const [topic, payload] = publish.mock.calls[0] as [
      string,
      CampaignsPackContract,
    ];
    expect(topic).toBe(CAMPAIGNS_PACK_TOPIC);
    expect(payload).toMatchObject({
      campaignId: CAMPAIGN_ID,
      triggeredBy: 'schedule',
      correlationId: CORRELATION_ID,
    });
    expect(typeof payload.triggeredAt).toBe('string');
    // The published payload must satisfy the landed story-1.5 contract.
    expect(isCampaignsPackContract(payload)).toBe(true);
  });

  it('propagates a broker error so Temporal applies the activity retry policy (AC4)', async () => {
    const brokerError = new Error('broker timeout');
    publish.mockRejectedValueOnce(brokerError);

    await expect(
      publishCampaignsPack({
        campaignId: CAMPAIGN_ID,
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow('broker timeout');
  });
});
