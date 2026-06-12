import { CampaignsControlConsumer } from './campaigns-control.consumer';
import {
  CAMPAIGNS_CONTROL_TOPIC,
  type CampaignsControlContract,
} from '../../../shared/broker/contracts/campaigns-control.contract';
import type { BrokerMessage } from '../../../shared/broker/interfaces/message-broker.interface';

const buildMsg = (
  payload: unknown,
): BrokerMessage<CampaignsControlContract> => ({
  id: 'm1',
  payload: payload as CampaignsControlContract,
  headers: {},
  raw: {},
});

const control = (
  action: CampaignsControlContract['action'],
): CampaignsControlContract => ({
  campaignId: 'camp-1',
  action,
  correlationId: '11111111-1111-4111-8111-111111111111',
});

describe('CampaignsControlConsumer (campaign-packer)', () => {
  let consumer: CampaignsControlConsumer;
  let broker: { subscribe: jest.Mock; ack: jest.Mock; nack: jest.Mock };
  let markPaginationAborted: jest.Mock;
  let clearPaginationAborted: jest.Mock;
  let runWithCorrelationId: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    broker = { subscribe: jest.fn(), ack: jest.fn(), nack: jest.fn() };
    markPaginationAborted = jest.fn();
    clearPaginationAborted = jest.fn();
    runWithCorrelationId = jest.fn((_id: string, fn: () => unknown) => fn());
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    consumer = new CampaignsControlConsumer(
      broker as any,
      { markPaginationAborted, clearPaginationAborted } as any,
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

  it.each(['pause', 'stop'] as const)(
    'AC1/AC4: marks pagination aborted on %s and acks',
    async (action) => {
      const handler = await getHandler();

      await handler(buildMsg(control(action)));

      expect(markPaginationAborted).toHaveBeenCalledWith('camp-1');
      expect(clearPaginationAborted).not.toHaveBeenCalled();
      expect(broker.ack).toHaveBeenCalledTimes(1);
    },
  );

  it('AC3: clears the abort flag on resume', async () => {
    const handler = await getHandler();

    await handler(buildMsg(control('resume')));

    expect(clearPaginationAborted).toHaveBeenCalledWith('camp-1');
    expect(markPaginationAborted).not.toHaveBeenCalled();
    expect(broker.ack).toHaveBeenCalledTimes(1);
  });

  it('nack(requeue=false) on a malformed payload', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ campaignId: 'x', action: 'nope' }));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(markPaginationAborted).not.toHaveBeenCalled();
    expect(clearPaginationAborted).not.toHaveBeenCalled();
  });
});
