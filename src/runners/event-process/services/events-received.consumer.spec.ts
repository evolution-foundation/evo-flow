import { EVENTS_RECEIVED_TOPIC_PREFIX } from 'src/shared/broker/contracts/events-received.contract';
import { BrokerMessage } from 'src/shared/broker/interfaces/message-broker.interface';
import { EventsReceivedConsumer } from './events-received.consumer';
import { InvalidEnvelopeError } from './event-process.service';

type Handler = (msg: BrokerMessage) => Promise<void>;

function buildMsg(overrides: Partial<BrokerMessage> = {}): BrokerMessage {
  return {
    id: 'events.received/1',
    payload: { platform: 'evolution-api' },
    headers: { correlationId: 'cid-123' },
    raw: {},
    ...overrides,
  };
}

describe('EventsReceivedConsumer', () => {
  function setup() {
    let captured: Handler | undefined;
    const broker = {
      subscribePattern: jest.fn((_prefix: string, handler: Handler) => {
        captured = handler;
        return Promise.resolve();
      }),
      ack: jest.fn(() => Promise.resolve()),
      nack: jest.fn(() => Promise.resolve()),
      publish: jest.fn(),
      subscribe: jest.fn(),
    };
    const correlation = {
      // Invoke fn synchronously so the handler body runs under the test.
      runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
      resolveIncoming: jest.fn((incoming?: string) => incoming ?? 'minted-id'),
    };
    const service = { handle: jest.fn(() => Promise.resolve()) };
    const consumer = new EventsReceivedConsumer(
      broker as never,
      correlation as never,
      service as never,
    );
    return {
      consumer,
      broker,
      correlation,
      service,
      getHandler: () => captured,
    };
  }

  it('subscribes to the events.received prefix on init', async () => {
    const { consumer, broker } = setup();
    await consumer.onApplicationBootstrap();
    expect(broker.subscribePattern).toHaveBeenCalledWith(
      EVENTS_RECEIVED_TOPIC_PREFIX,
      expect.any(Function),
    );
  });

  it('runs the handler under the message correlationId and acks on success', async () => {
    const { consumer, broker, correlation, service, getHandler } = setup();
    await consumer.onApplicationBootstrap();
    const msg = buildMsg();

    await getHandler()!(msg);

    expect(correlation.resolveIncoming).toHaveBeenCalledWith('cid-123');
    expect(correlation.runWithCorrelationId).toHaveBeenCalledWith(
      'cid-123',
      expect.any(Function),
    );
    expect(service.handle).toHaveBeenCalledWith(msg.payload);
    expect(broker.ack).toHaveBeenCalledWith(msg);
    expect(broker.nack).not.toHaveBeenCalled();
  });

  it('nacks with requeue on a transient (non-validation) failure', async () => {
    const { consumer, broker, service, getHandler } = setup();
    service.handle.mockRejectedValueOnce(new Error('boom'));
    await consumer.onApplicationBootstrap();
    const msg = buildMsg();

    await getHandler()!(msg);

    expect(broker.ack).not.toHaveBeenCalled();
    expect(broker.nack).toHaveBeenCalledWith(msg, true);
  });

  it('drops (terminal nack) an invalid envelope instead of requeuing forever', async () => {
    const { consumer, broker, service, getHandler } = setup();
    service.handle.mockRejectedValueOnce(new InvalidEnvelopeError('bad'));
    await consumer.onApplicationBootstrap();
    const msg = buildMsg();

    await getHandler()!(msg);

    expect(broker.ack).not.toHaveBeenCalled();
    expect(broker.nack).toHaveBeenCalledWith(msg, false);
  });
});
