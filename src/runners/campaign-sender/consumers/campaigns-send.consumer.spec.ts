import { CampaignsSendConsumer } from './campaigns-send.consumer';
import { CampaignNotFoundError } from '../errors/campaign-not-found.error';
import {
  CAMPAIGNS_SEND_TOPIC,
  type CampaignsSendContract,
} from '../../../shared/broker/contracts/campaigns-send.contract';
import type { BrokerMessage } from '../../../shared/broker/interfaces/message-broker.interface';

const validPayload: CampaignsSendContract = {
  campaignId: 'camp-1',
  page: 1,
  totalPages: 2,
  contactIds: ['c1', 'c2'],
  templateId: 'tpl-1',
  channelType: 'whatsapp',
  correlationId: '11111111-1111-4111-8111-111111111111',
};

const buildMsg = (payload: unknown): BrokerMessage<CampaignsSendContract> => ({
  id: 'm1',
  payload: payload as CampaignsSendContract,
  headers: {},
  raw: {},
});

describe('CampaignsSendConsumer', () => {
  let consumer: CampaignsSendConsumer;
  let broker: {
    subscribe: jest.Mock;
    ack: jest.Mock;
    nack: jest.Mock;
    getTopicLag: jest.Mock;
  };
  let send: jest.Mock;
  let runWithCorrelationId: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let metrics: {
    observeRequestDuration: jest.Mock;
    incError: jest.Mock;
    setConsumerLag: jest.Mock;
  };

  beforeEach(() => {
    broker = {
      subscribe: jest.fn(),
      ack: jest.fn(),
      nack: jest.fn(),
      getTopicLag: jest.fn().mockResolvedValue(0),
    };
    send = jest.fn();
    runWithCorrelationId = jest.fn((_id: string, fn: () => unknown) => fn());
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    metrics = {
      observeRequestDuration: jest.fn(),
      incError: jest.fn(),
      setConsumerLag: jest.fn(),
    };
    consumer = new CampaignsSendConsumer(
      broker as any,
      { send } as any,
      { runWithCorrelationId } as any,
      logger as any,
      metrics as any,
    );
  });

  afterEach(() => {
    consumer.onModuleDestroy();
    jest.useRealTimers();
  });

  async function getHandler() {
    await consumer.onModuleInit();
    return broker.subscribe.mock.calls[0][1] as (
      m: BrokerMessage<CampaignsSendContract>,
    ) => Promise<void>;
  }

  it('AC5: subscribes to campaigns.send on module init', async () => {
    await consumer.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      CAMPAIGNS_SEND_TOPIC,
      expect.any(Function),
    );
  });

  it('acks after a successful send and observes the message duration', async () => {
    send.mockResolvedValueOnce({
      dispatched: 2,
      skipped: 0,
      failed: 0,
      aborted: false,
    });
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(send).toHaveBeenCalledWith(validPayload);
    expect(broker.ack).toHaveBeenCalledTimes(1);
    expect(broker.nack).not.toHaveBeenCalled();
    expect(metrics.observeRequestDuration).toHaveBeenCalledWith(
      CAMPAIGNS_SEND_TOPIC,
      expect.any(Number),
    );
  });

  it('AC3: acks a pause/stop abort (send returns normally)', async () => {
    send.mockResolvedValueOnce({
      dispatched: 0,
      skipped: 0,
      failed: 0,
      aborted: true,
    });
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.ack).toHaveBeenCalledTimes(1);
    expect(broker.nack).not.toHaveBeenCalled();
  });

  it('wraps processing in the payload correlationId', async () => {
    send.mockResolvedValueOnce({
      dispatched: 0,
      skipped: 2,
      failed: 0,
      aborted: false,
    });
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(runWithCorrelationId).toHaveBeenCalledWith(
      validPayload.correlationId,
      expect.any(Function),
    );
  });

  it('nack(requeue=false) on a terminal error', async () => {
    send.mockRejectedValueOnce(new CampaignNotFoundError('camp-1'));
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(broker.ack).not.toHaveBeenCalled();
  });

  it('nack(requeue=true) on a transient error', async () => {
    send.mockRejectedValueOnce(new Error('db unavailable'));
    const handler = await getHandler();

    await handler(buildMsg(validPayload));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('nack(requeue=false) on a malformed payload, without calling send', async () => {
    const handler = await getHandler();

    await handler(buildMsg({ campaignId: 'x' }));

    expect(broker.nack).toHaveBeenCalledWith(expect.anything(), false);
    expect(send).not.toHaveBeenCalled();
    expect(runWithCorrelationId).not.toHaveBeenCalled();
    expect(metrics.incError).toHaveBeenCalledWith('malformed_payload');
  });

  it('AC6: polls the broker lag and publishes the consumer_lag gauge', async () => {
    jest.useFakeTimers();
    broker.getTopicLag.mockResolvedValue(42);

    await consumer.onModuleInit();
    await jest.advanceTimersByTimeAsync(15_000);

    expect(broker.getTopicLag).toHaveBeenCalledWith(CAMPAIGNS_SEND_TOPIC);
    expect(metrics.setConsumerLag).toHaveBeenCalledWith(
      CAMPAIGNS_SEND_TOPIC,
      42,
    );
  });

  it('a failed lag poll only warns and never touches message processing', async () => {
    jest.useFakeTimers();
    broker.getTopicLag.mockRejectedValue(new Error('admin down'));

    await consumer.onModuleInit();
    await jest.advanceTimersByTimeAsync(15_000);

    expect(metrics.setConsumerLag).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('consumer lag poll failed'),
      'CampaignsSendConsumer',
    );
  });

  it('stops the lag poll on module destroy', async () => {
    jest.useFakeTimers();
    await consumer.onModuleInit();
    consumer.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(broker.getTopicLag).not.toHaveBeenCalled();
  });
});
