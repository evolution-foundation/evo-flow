import { BrokerHealthIndicator } from './broker.health-indicator';
import { IMessageBroker } from '../../shared/broker/interfaces/message-broker.interface';

describe('BrokerHealthIndicator', () => {
  const build = (healthCheck: jest.Mock) =>
    new BrokerHealthIndicator({ healthCheck } as unknown as IMessageBroker);

  it('up when connected and no missing topics', async () => {
    const indicator = build(
      jest.fn().mockResolvedValue({ connected: true, missingTopics: [] }),
    );
    await expect(indicator.check()).resolves.toEqual({
      name: 'broker',
      status: 'up',
    });
  });

  it('down with "broker not connected" when transport is down', async () => {
    const indicator = build(
      jest.fn().mockResolvedValue({
        connected: false,
        missingTopics: ['campaigns.pack'],
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'broker', status: 'down' });
    expect(result.error).toBe('broker not connected');
  });

  it('down with missing topics surfaced in detail', async () => {
    const indicator = build(
      jest.fn().mockResolvedValue({
        connected: true,
        missingTopics: ['campaigns.pack'],
      }),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({
      name: 'broker',
      status: 'down',
      error: 'missing topics',
      detail: { missingTopics: ['campaigns.pack'] },
    });
  });

  it('down (never throws) when healthCheck itself rejects', async () => {
    const indicator = build(
      jest.fn().mockRejectedValue(new Error('admin gone')),
    );
    const result = await indicator.check();
    expect(result).toMatchObject({ name: 'broker', status: 'down' });
    expect(result.error).toContain('admin gone');
  });
});
