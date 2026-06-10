const mockReadCls = jest.fn<string | undefined, []>();

jest.mock('src/shared/correlation/correlation.util', () => ({
  readCorrelationIdFromCls: (): string | undefined => mockReadCls(),
}));

import { DlqPublisherService } from './dlq-publisher.service';
import { EventProcessMetrics } from '../metrics/event-process-metrics';
import { IMessageBroker } from 'src/shared/broker/interfaces/message-broker.interface';
import { isEventsFailedContract } from 'src/shared/broker/contracts/events-failed.contract';

const CORRELATION = '11111111-1111-4111-8111-111111111111';
const CLS_CORRELATION = '22222222-2222-4222-8222-222222222222';

describe('DlqPublisherService', () => {
  let service: DlqPublisherService;
  let publish: jest.Mock;
  let publishedInc: jest.Mock;
  let failedInc: jest.Mock;

  beforeEach(() => {
    mockReadCls.mockReset().mockReturnValue(undefined);
    publish = jest.fn().mockResolvedValue(undefined);
    publishedInc = jest.fn();
    failedInc = jest.fn();
    service = new DlqPublisherService(
      { publish } as unknown as IMessageBroker,
      {
        eventsFailedPublishedTotal: { inc: publishedInc },
        dlqPublishFailedTotal: { inc: failedInc },
      } as unknown as EventProcessMetrics,
    );
  });

  it('publishes a contract-valid events.failed payload and counts the reason (AC1)', async () => {
    await service.publish(
      'events.received.evolution-api',
      { rawPayload: '{"x":1}' },
      'clickhouse_insert_exhausted_retries',
      3,
      CORRELATION,
    );

    const [topic, payload] = publish.mock.calls[0] as [string, unknown];
    expect(topic).toBe('events.failed');
    expect(isEventsFailedContract(payload)).toBe(true);
    expect(payload).toMatchObject({
      originalTopic: 'events.received.evolution-api',
      failureReason: 'clickhouse_insert_exhausted_retries',
      attempts: 3,
      correlationId: CORRELATION,
    });
    expect(publishedInc).toHaveBeenCalledWith({
      reason: 'clickhouse_insert_exhausted_retries',
    });
  });

  it('prefers the explicit correlationId over the CLS one', async () => {
    mockReadCls.mockReturnValue(CLS_CORRELATION);

    await service.publish('t', {}, 'r', 1, CORRELATION);

    expect(
      (publish.mock.calls[0] as [string, { correlationId: string }])[1]
        .correlationId,
    ).toBe(CORRELATION);
  });

  it('falls back to the CLS correlationId when no parameter is given', async () => {
    mockReadCls.mockReturnValue(CLS_CORRELATION);

    await service.publish('t', {}, 'r', 1);

    expect(
      (publish.mock.calls[0] as [string, { correlationId: string }])[1]
        .correlationId,
    ).toBe(CLS_CORRELATION);
  });

  it('generates a UUID (still contract-valid) when neither parameter nor CLS provide one', async () => {
    await service.publish('t', {}, 'r', 1);

    const payload = (publish.mock.calls[0] as [string, unknown])[1];
    expect(isEventsFailedContract(payload)).toBe(true);
  });

  it('logs + counts a publish failure without throwing (last resort)', async () => {
    publish.mockRejectedValue(new Error('broker down'));

    await expect(
      service.publish('t', {}, 'r', 1, CORRELATION),
    ).resolves.toBeUndefined();

    expect(failedInc).toHaveBeenCalledTimes(1);
    expect(publishedInc).not.toHaveBeenCalled();
  });
});
