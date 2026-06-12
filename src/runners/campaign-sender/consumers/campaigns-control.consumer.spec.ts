import { CampaignsControlConsumer } from './campaigns-control.consumer';
import {
  CAMPAIGNS_CONTROL_TOPIC,
  type CampaignsControlContract,
} from '../../../shared/broker/contracts/campaigns-control.contract';
import type { BrokerMessage } from '../../../shared/broker/interfaces/message-broker.interface';

const validPayload: CampaignsControlContract = {
  campaignId: 'camp-1',
  action: 'pause',
  correlationId: '11111111-1111-4111-8111-111111111111',
};

const buildMsg = (
  payload: unknown,
): BrokerMessage<CampaignsControlContract> => ({
  id: 'm1',
  payload: payload as CampaignsControlContract,
  headers: {},
  raw: {},
});

describe('CampaignsControlConsumer (campaign-sender)', () => {
  let consumer: CampaignsControlConsumer;
  let broker: { subscribe: jest.Mock; ack: jest.Mock; nack: jest.Mock };
  let invalidateStatusCache: jest.Mock;
  let runWithCorrelationId: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    broker = { subscribe: jest.fn(), ack: jest.fn(), nack: jest.fn() };
    invalidateStatusCache = jest.fn();
    runWithCorrelationId = jest.fn((_id: string, fn: () => unknown) => fn());
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    consumer = new CampaignsControlConsumer(
      broker as any,
      { invalidateStatusCache } as any,
      { runWithCorrelationId } as any,
      logger as any,
    );
  });

  async function getHandler() {
    await consumer.onModuleInit();
    return broker.subscribe.mock.calls[0][1] as (
      m: BrokerMessage<CampaignsControlContract>,
    ) => Promise<void>;
  }

  it('AC5: subscribes to campaigns.control on module init', async () => {
    await consumer.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      CAMPAIGNS_CONTROL_TOPIC,
      expect.any(Function),
    );
  });

  it('AC1: invalidates the cached status for the campaign and acks', async () => {
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(invalidateStatusCache).toHaveBeenCalledWith('camp-1');
    expect(broker.ack).toHaveBeenCalledTimes(1);
    expect(broker.nack).not.toHaveBeenCalled();
  });

  it('invalidates regardless of the action (resume also re-reads the flag)', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ ...validPayload, action: 'resume' }));

    expect(invalidateStatusCache).toHaveBeenCalledWith('camp-1');
    expect(broker.ack).toHaveBeenCalledTimes(1);
  });

  it('wraps processing in the payload correlationId', async () => {
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(runWithCorrelationId).toHaveBeenCalledWith(
      validPayload.correlationId,
      expect.any(Function),
    );
  });

  it('nack(requeue=false) on a malformed payload, without invalidating', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ campaignId: 'x' }));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(invalidateStatusCache).not.toHaveBeenCalled();
    expect(runWithCorrelationId).not.toHaveBeenCalled();
  });
});
