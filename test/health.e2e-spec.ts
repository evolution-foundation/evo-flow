import { Controller, Get, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import {
  ACTIVE_INDICATORS,
  HealthIndicator,
} from '../src/health/indicators/health-indicator.interface';

// A normal controller WITHOUT @SkipResponseTransform — proves the global
// interceptor is genuinely active, so the health bypass is selective (not a
// case of the interceptor being globally off).
@Controller()
class WrappedDemoController {
  @Get('wrapped-demo')
  demo() {
    return { foo: 'bar' };
  }
}

const indicator = (
  name: string,
  status: 'up' | 'down',
  extra: { error?: string; detail?: Record<string, unknown> } = {},
): HealthIndicator => ({
  name,
  check: () => Promise.resolve({ name, status, ...extra }),
});

async function buildApp(
  indicators: HealthIndicator[],
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController, WrappedDemoController],
    providers: [{ provide: ACTIVE_INDICATORS, useValue: indicators }],
  }).compile();
  const app = moduleRef.createNestApplication();
  // Same registration as main.ts (HTTP modes): the interceptor must honor
  // @SkipResponseTransform via Reflector.
  app.useGlobalInterceptors(
    new ResponseTransformInterceptor(app.get(Reflector)),
  );
  await app.init();
  return app;
}

describe('Health endpoints (e2e)', () => {
  it('GET /health → 200 {status:ok}, un-wrapped (skip-transform honored)', async () => {
    const app = await buildApp([indicator('postgres', 'up')]);
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.body).not.toHaveProperty('success'); // not the {success,data,meta} envelope
    await app.close();
  });

  it('GET /ready all up → 200 {status:up, checks}, un-wrapped', async () => {
    const app = await buildApp([
      indicator('postgres', 'up'),
      indicator('redis', 'up'),
      indicator('broker', 'up'),
    ]);
    const res = await request(app.getHttpServer()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'up',
      checks: { postgres: 'up', redis: 'up', broker: 'up' },
    });
    await app.close();
  });

  it('GET /ready with redis down → 503 naming the failing indicator + detail', async () => {
    const app = await buildApp([
      indicator('postgres', 'up'),
      indicator('redis', 'down', { error: 'NOAUTH' }),
      indicator('broker', 'up'),
    ]);
    const res = await request(app.getHttpServer()).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'down',
      failing: ['redis'],
      checks: { postgres: 'up', redis: 'down', broker: 'up' },
      details: { redis: { error: 'NOAUTH' } },
    });
    await app.close();
  });

  it('a normal controller IS still wrapped → bypass is selective', async () => {
    const app = await buildApp([indicator('postgres', 'up')]);
    const res = await request(app.getHttpServer()).get('/wrapped-demo');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { foo: 'bar' } });
    await app.close();
  });
});
