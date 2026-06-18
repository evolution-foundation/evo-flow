import { ConfigService } from '@nestjs/config';
import { KafkaBrokerAdapter } from './kafka-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';

describe('KafkaBrokerAdapter.healthCheck', () => {
  const build = () => {
    const adapter = new KafkaBrokerAdapter(
      { get: jest.fn() } as unknown as ConfigService,
      {} as unknown as BrokerMetrics,
    );
    const listTopics = jest.fn();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      active: true,
      producer: {},
      admin: { listTopics },
    });
    return { adapter, listTopics };
  };

  it('reports not connected when inactive', async () => {
    const { adapter, listTopics } = build();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      active: false,
    });
    await expect(adapter.healthCheck(['campaigns.pack'])).resolves.toEqual({
      connected: false,
      missingTopics: ['campaigns.pack'],
    });
    expect(listTopics).not.toHaveBeenCalled();
  });

  it('connection-only (no listTopics) when expected list is empty', async () => {
    const { adapter, listTopics } = build();
    await expect(adapter.healthCheck([])).resolves.toEqual({
      connected: true,
      missingTopics: [],
    });
    expect(listTopics).not.toHaveBeenCalled();
  });

  it('flags topics absent from listTopics()', async () => {
    const { adapter, listTopics } = build();
    listTopics.mockResolvedValue(['campaigns.pack']);
    await expect(
      adapter.healthCheck(['campaigns.pack', 'campaigns.send']),
    ).resolves.toEqual({ connected: true, missingTopics: ['campaigns.send'] });
  });

  it('treats a listTopics() failure as not connected', async () => {
    const { adapter, listTopics } = build();
    listTopics.mockRejectedValue(new Error('metadata timeout'));
    await expect(adapter.healthCheck(['campaigns.pack'])).resolves.toEqual({
      connected: false,
      missingTopics: ['campaigns.pack'],
    });
  });
});
