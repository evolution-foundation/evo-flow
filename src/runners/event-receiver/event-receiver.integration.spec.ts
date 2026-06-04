import {
  INestApplication,
  MiddlewareConsumer,
  Module,
  RequestMethod,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { json, raw, urlencoded } from 'express';
import * as request from 'supertest';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookIntakeService } from './services/webhook-intake.service';
import { PlatformDetectorService } from './services/platform-detector.service';
import { PayloadNormalizerService } from './services/payload-normalizer.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { CorrelationModule } from '../../shared/correlation/correlation.module';
import { RequestContextMiddleware } from '../../middlewares/request-context.middleware';
import { readCorrelationIdFromCls } from '../../shared/correlation/correlation.util';
import { IMESSAGE_BROKER } from '../../shared/broker/interfaces/message-broker.interface';
import {
  EventsReceivedContract,
  isEventsReceivedContract,
} from '../../shared/broker/contracts';

type PublishCall = [string, EventsReceivedContract];

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Boots the receiver over real HTTP with the same body-parser + global-prefix +
 * correlation-middleware wiring as main.ts, exercising the catch-all route and
 * the three acceptance criteria end-to-end. The logger is mocked to capture the
 * correlationId present in CLS at log time (AC3) without touching the filesystem.
 */
describe('event-receiver (integration)', () => {
  let app: INestApplication;
  const loggedCorrelationIds: (string | undefined)[] = [];
  const brokerMock = { publish: jest.fn().mockResolvedValue(undefined) };

  const loggerMock = {
    log: jest.fn(() => {
      loggedCorrelationIds.push(readCorrelationIdFromCls());
    }),
    warn: jest.fn(),
    error: jest.fn(),
  };

  @Module({
    imports: [
      ClsModule.forRoot({ global: true, middleware: { mount: false } }),
      CorrelationModule,
    ],
    controllers: [WebhooksController],
    providers: [
      WebhookIntakeService,
      PlatformDetectorService,
      PayloadNormalizerService,
      { provide: CustomLoggerService, useValue: loggerMock },
      { provide: IMESSAGE_BROKER, useValue: brokerMock },
    ],
  })
  class TestAppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(ClsMiddleware).forRoutes('*');
      consumer.apply(RequestContextMiddleware).forRoutes('*');
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(
      '/webhooks',
      raw({
        type: () => true,
        limit: '5mb',
        verify: (req, _res, buf: Buffer) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use(json());
    app.use(urlencoded({ extended: true }));
    app.setGlobalPrefix('api/v1', {
      exclude: [{ path: 'webhooks/*splat', method: RequestMethod.POST }],
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    loggedCorrelationIds.length = 0;
    jest.clearAllMocks();
  });

  it('AC1: POST /webhooks/evolution-api with valid JSON → 200 { ok: true }', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .send('{"foo":"bar"}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('AC2: malformed JSON → 400 { error: malformed_payload }', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .send('malformed{{');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed_payload' });
  });

  it('AC3: no X-Correlation-Id header → a UUID v4 correlationId is present in logs', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .send('{"foo":"bar"}')
      .expect(200);

    const ids = loggedCorrelationIds.filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(UUID_V4);
  });

  it('preserves a valid inbound X-Correlation-Id (cross-service chaining)', async () => {
    const incoming = 'trace-abc_123';
    await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-Id', incoming)
      .send('{"foo":"bar"}')
      .expect(200);

    expect(loggedCorrelationIds).toContain(incoming);
  });

  it('routes multi-segment catch-all paths to the receiver', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution-api/instance-1')
      .set('Content-Type', 'application/json')
      .send('{"foo":"bar"}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('3.2-AC1: publishes a complete envelope to events.received.evolution-api', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
      .send('{"event":"delivered"}')
      .expect(200);

    expect(brokerMock.publish).toHaveBeenCalledTimes(1);
    const [topic, envelope] = brokerMock.publish.mock.calls[0] as PublishCall;
    expect(topic).toBe('events.received.evolution-api');
    expect(isEventsReceivedContract(envelope)).toBe(true);
    expect(envelope).toMatchObject({
      platform: 'evolution-api',
      rawPayload: '{"event":"delivered"}',
      sourceIp: '203.0.113.7',
    });
    expect(envelope.ingestionId).toMatch(UUID_V4);
    expect(envelope.correlationId).toMatch(UUID_V4);
    expect(envelope.receivedAt).toBe(
      new Date(envelope.receivedAt).toISOString(),
    );
  });

  it('3.2-AC2: an unrecognized platform publishes to events.received.unknown (200)', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/foo')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [topic, envelope] = brokerMock.publish.mock.calls[0] as PublishCall;
    expect(topic).toBe('events.received.unknown');
    expect(envelope.platform).toBe('unknown');
  });

  it('3.2-AC3: a broker publish failure returns 503 with Retry-After: 10', async () => {
    brokerMock.publish.mockRejectedValueOnce(new Error('broker down'));

    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution-api')
      .set('Content-Type', 'application/json')
      .send('{"event":"delivered"}');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.body).toEqual({ error: 'service_unavailable' });
  });
});
