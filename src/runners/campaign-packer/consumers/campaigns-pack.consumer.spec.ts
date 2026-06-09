import { CampaignsPackConsumer } from './campaigns-pack.consumer';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import {
  CAMPAIGNS_PACK_TOPIC,
  type CampaignsPackContract,
} from '../../../shared/broker/contracts/campaigns-pack.contract';
import type { BrokerMessage } from '../../../shared/broker/interfaces/message-broker.interface';

const validPayload: CampaignsPackContract = {
  campaignId: 'camp-1',
  triggeredAt: '2026-06-09T00:00:00.000Z',
  triggeredBy: 'schedule',
  correlationId: '11111111-1111-4111-8111-111111111111',
};

const buildMsg = (payload: unknown): BrokerMessage<CampaignsPackContract> => ({
  id: 'm1',
  payload: payload as CampaignsPackContract,
  headers: {},
  raw: {},
});

describe('CampaignsPackConsumer', () => {
  let consumer: CampaignsPackConsumer;
  let broker: { subscribe: jest.Mock; ack: jest.Mock; nack: jest.Mock };
  let pack: jest.Mock;
  let runWithCorrelationId: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    broker = { subscribe: jest.fn(), ack: jest.fn(), nack: jest.fn() };
    pack = jest.fn();
    runWithCorrelationId = jest.fn((_id: string, fn: () => unknown) => fn());
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    consumer = new CampaignsPackConsumer(
      broker as any,
      { pack } as any,
      { runWithCorrelationId } as any,
      logger as any,
    );
  });

  async function getHandler() {
    await consumer.onModuleInit();
    return broker.subscribe.mock.calls[0][1] as (
      m: BrokerMessage<CampaignsPackContract>,
    ) => Promise<void>;
  }

  it('AC3: subscribes to campaigns.pack on module init', async () => {
    await consumer.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      CAMPAIGNS_PACK_TOPIC,
      expect.any(Function),
    );
  });

  it('AC1: acks after a successful pack', async () => {
    pack.mockResolvedValueOnce({ audienceSize: 5 });
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(pack).toHaveBeenCalledWith(validPayload);
    expect(broker.ack).toHaveBeenCalledTimes(1);
    expect(broker.nack).not.toHaveBeenCalled();
  });

  it('AC4: wraps processing in the payload correlationId', async () => {
    pack.mockResolvedValueOnce({ audienceSize: 1 });
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(runWithCorrelationId).toHaveBeenCalledWith(
      validPayload.correlationId,
      expect.any(Function),
    );
  });

  it('AC2: nack(requeue=false) when the campaign is not found', async () => {
    pack.mockRejectedValueOnce(new CampaignNotFoundError('camp-1'));
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(broker.ack).not.toHaveBeenCalled();
  });

  it('nack(requeue=true) on a transient error', async () => {
    pack.mockRejectedValueOnce(new Error('db unavailable'));
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('nack(requeue=false) on a malformed payload, without calling pack', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ campaignId: 'x' }));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(pack).not.toHaveBeenCalled();
    expect(runWithCorrelationId).not.toHaveBeenCalled();
  });
});
