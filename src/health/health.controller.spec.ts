import { HealthController } from './health.controller';
import {
  HealthIndicator,
  IndicatorResult,
} from './indicators/health-indicator.interface';
import type { Response } from 'express';

const upIndicator = (name: string): HealthIndicator => ({
  name,
  check: jest.fn().mockResolvedValue({ name, status: 'up' } as IndicatorResult),
});
const downIndicator = (name: string): HealthIndicator => ({
  name,
  check: jest
    .fn()
    .mockResolvedValue({ name, status: 'down', error: 'x' } as IndicatorResult),
});
const throwingIndicator = (name: string): HealthIndicator => ({
  name,
  check: jest.fn().mockRejectedValue(new Error('unexpected throw')),
});

const fakeRes = () => {
  const status = jest.fn();
  const res = { status } as unknown as Response;
  return { res, status };
};

describe('HealthController', () => {
  describe('liveness', () => {
    it('returns 200 ok without touching any indicator', () => {
      const check = jest.fn();
      const indicator: HealthIndicator = { name: 'postgres', check };
      const controller = new HealthController([indicator]);
      expect(controller.liveness()).toEqual({ status: 'ok' });
      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('200 with all checks up when every indicator is up', async () => {
      const controller = new HealthController([
        upIndicator('postgres'),
        upIndicator('redis'),
        upIndicator('broker'),
      ]);
      const { res, status } = fakeRes();
      const body = await controller.readiness(res);
      expect(status).not.toHaveBeenCalled();
      expect(body).toEqual({
        status: 'up',
        checks: { postgres: 'up', redis: 'up', broker: 'up' },
      });
    });

    it('503 naming the failing indicator when one is down', async () => {
      const controller = new HealthController([
        upIndicator('postgres'),
        downIndicator('redis'),
        upIndicator('broker'),
      ]);
      const { res, status } = fakeRes();
      const body = await controller.readiness(res);
      expect(status).toHaveBeenCalledWith(503);
      expect(body).toEqual({
        status: 'down',
        failing: ['redis'],
        checks: { postgres: 'up', redis: 'down', broker: 'up' },
      });
    });

    it('a throwing indicator degrades to down (503), does not reject', async () => {
      const controller = new HealthController([
        upIndicator('postgres'),
        throwingIndicator('broker'),
      ]);
      const { res, status } = fakeRes();
      const body = await controller.readiness(res);
      expect(status).toHaveBeenCalledWith(503);
      expect(body.failing).toEqual(['broker']);
      expect(body.checks).toEqual({ postgres: 'up', broker: 'down' });
    });
  });
});
