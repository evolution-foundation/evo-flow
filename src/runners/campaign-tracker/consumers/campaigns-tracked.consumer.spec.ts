import { CampaignsTrackedConsumer } from './campaigns-tracked.consumer';
import { CAMPAIGNS_TRACKED_TOPIC } from '../../../shared/broker/contracts/campaigns-tracked.contract';
import type { CampaignsTrackedContract } from '../../../shared/broker/contracts/campaigns-tracked.contract';
import type { BrokerMessage } from '../../../shared/broker/interfaces/message-broker.interface';

const validPayload: CampaignsTrackedContract = {
  campaignId: 'camp-1',
  page: 1,
  sentCount: 5,
  failedCount: 0,
  completed: false,
  correlationId: '11111111-1111-4111-8111-111111111111',
};

const buildMsg = (
  payload: unknown,
): BrokerMessage<CampaignsTrackedContract> => ({
  id: 'm1',
  payload: payload as CampaignsTrackedContract,
  headers: {},
  raw: {},
});

describe('CampaignsTrackedConsumer', () => {
  let broker: { subscribe: jest.Mock; ack: jest.Mock; nack: jest.Mock };
  let record: jest.Mock;
  let runWithCorrelationId: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let consumer: CampaignsTrackedConsumer;

  beforeEach(() => {
    broker = { subscribe: jest.fn(), ack: jest.fn(), nack: jest.fn() };
    record = jest.fn();
    runWithCorrelationId = jest.fn((_id: string, fn: () => unknown) => fn());
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    consumer = new CampaignsTrackedConsumer(
      broker as any,
      { record } as any,
      { runWithCorrelationId } as any,
      logger as any,
    );
  });

  const getHandler = async (): Promise<
    (msg: BrokerMessage<CampaignsTrackedContract>) => Promise<void>
  > => {
    await consumer.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      CAMPAIGNS_TRACKED_TOPIC,
      expect.any(Function),
    );
    const calls = broker.subscribe.mock.calls as Array<
      [string, (msg: BrokerMessage<CampaignsTrackedContract>) => Promise<void>]
    >;
    return calls[0][1];
  };

  it('subscribes to campaigns.tracked on boot', async () => {
    await consumer.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      CAMPAIGNS_TRACKED_TOPIC,
      expect.any(Function),
    );
  });

  it('routes a valid message to the tracker and acks', async () => {
    record.mockResolvedValueOnce(undefined);
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(record).toHaveBeenCalledWith(validPayload);
    expect(broker.ack).toHaveBeenCalled();
    expect(broker.nack).not.toHaveBeenCalled();
  });

  it('drops a structurally invalid payload with nack(requeue=false)', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ campaignId: 'camp-1' }));

    expect(record).not.toHaveBeenCalled();
    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('nacks(requeue=true) when the tracker throws a transient error', async () => {
    record.mockRejectedValueOnce(new Error('db down'));
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), true);
  });
});
