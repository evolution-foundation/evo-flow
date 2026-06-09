import { Response } from 'express';
import { MetricsController } from './metrics.controller';
import { PrometheusMetrics } from '../modules/processing/metrics/prometheus-metrics';

describe('MetricsController', () => {
  it('awaits the async getMetrics() and sends the resolved text, not a Promise', async () => {
    const payload = '# HELP evo_flow_throughput_total ...\n';
    const getMetrics = jest.fn().mockResolvedValue(payload);
    const metrics = { getMetrics } as unknown as PrometheusMetrics;
    const controller = new MetricsController(metrics);

    const set = jest.fn().mockReturnThis();
    const send = jest.fn().mockReturnThis();
    const res = { set, send } as unknown as Response;

    await controller.getMetrics(res);

    expect(set).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(send).toHaveBeenCalledWith(payload);
    const calls = send.mock.calls as unknown[][];
    const sent = calls[0][0];
    expect(sent).not.toBeInstanceOf(Promise);
  });
});
