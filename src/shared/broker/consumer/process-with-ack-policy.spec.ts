import { processWithAckPolicy } from './process-with-ack-policy';
import { TerminalError } from '../../errors/terminal-error';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';

class SampleTerminalError extends TerminalError {}

describe('processWithAckPolicy', () => {
  let ack: jest.Mock;
  let nack: jest.Mock;
  let broker: IMessageBroker;
  let logger: any;
  const msg = {
    id: 'topic/1',
    payload: {},
    headers: {},
    raw: {},
  } as BrokerMessage;

  beforeEach(() => {
    ack = jest.fn().mockResolvedValue(undefined);
    nack = jest.fn().mockResolvedValue(undefined);
    broker = { ack, nack } as unknown as IMessageBroker;
    logger = { error: jest.fn() };
  });

  it('acks on success', async () => {
    await processWithAckPolicy(msg, broker, { logger, context: 'T' }, () =>
      Promise.resolve(),
    );

    expect(ack).toHaveBeenCalledWith(msg);
    expect(nack).not.toHaveBeenCalled();
  });

  it('nacks WITHOUT requeue on a TerminalError', async () => {
    await processWithAckPolicy(msg, broker, { logger, context: 'T' }, () =>
      Promise.reject(new SampleTerminalError('permanent')),
    );

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(msg, false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ terminal: true }),
    );
  });

  it('nacks WITH requeue on any other (transient) error', async () => {
    await processWithAckPolicy(msg, broker, { logger, context: 'T' }, () =>
      Promise.reject(new Error('transient')),
    );

    expect(nack).toHaveBeenCalledWith(msg, true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ terminal: false }),
    );
  });

  it('merges `meta` fields into the failure log', async () => {
    await processWithAckPolicy(
      msg,
      broker,
      { logger, context: 'T', meta: { campaignId: 'camp-9' } },
      () => Promise.reject(new Error('boom')),
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ campaignId: 'camp-9' }),
    );
  });
});
