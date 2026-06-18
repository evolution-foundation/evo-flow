import { ConfigService } from '@nestjs/config';
import { RabbitMQBrokerAdapter } from './rabbitmq-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';

describe('RabbitMQBrokerAdapter.healthCheck', () => {
  const build = () => {
    const adapter = new RabbitMQBrokerAdapter(
      { get: jest.fn() } as unknown as ConfigService,
      {} as unknown as BrokerMetrics,
    );
    const liveChannel = {
      checkExchange: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
    };
    const probeChannel = {
      checkExchange: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    const createChannel = jest.fn().mockResolvedValue(probeChannel);
    Object.assign(adapter as unknown as Record<string, unknown>, {
      active: true,
      connection: { createChannel },
      channel: liveChannel,
    });
    return { adapter, liveChannel, probeChannel, createChannel };
  };

  it('reports not connected when inactive', async () => {
    const { adapter, createChannel } = build();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      active: false,
    });
    await expect(adapter.healthCheck(['campaigns.pack'])).resolves.toEqual({
      connected: false,
      missingTopics: ['campaigns.pack'],
    });
    expect(createChannel).not.toHaveBeenCalled();
  });

  it('connection-only (no channel opened) when expected list is empty', async () => {
    const { adapter, createChannel } = build();
    await expect(adapter.healthCheck([])).resolves.toEqual({
      connected: true,
      missingTopics: [],
    });
    expect(createChannel).not.toHaveBeenCalled();
  });

  it('checks the EXCHANGE on a throwaway channel, never the live channel', async () => {
    const { adapter, liveChannel, probeChannel } = build();
    const result = await adapter.healthCheck(['campaigns.pack']);
    expect(result).toEqual({ connected: true, missingTopics: [] });
    // F3: must probe the resolved exchange ('campaigns.pack'), not checkQueue,
    // and must NOT touch the live consumer channel.
    expect(probeChannel.checkExchange).toHaveBeenCalledWith('campaigns.pack');
    expect(liveChannel.checkExchange).not.toHaveBeenCalled();
    expect(probeChannel.close).toHaveBeenCalled();
  });

  it('flags a missing exchange without taking down the live channel', async () => {
    const { adapter, liveChannel, probeChannel } = build();
    probeChannel.checkExchange.mockRejectedValue(new Error('NOT_FOUND'));
    const result = await adapter.healthCheck(['campaigns.pack']);
    expect(result).toEqual({
      connected: true,
      missingTopics: ['campaigns.pack'],
    });
    expect(liveChannel.checkExchange).not.toHaveBeenCalled();
  });
});
