import {
  BadRequestException,
  HttpException,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { ContactEventsController } from '../src/modules/events/controllers/contact-events.controller';
import { ContactEventsService } from '../src/modules/events/services/contact-events.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { ClickHouseService } from '../src/modules/processing/clickhouse/clickhouse.service';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';

// Mirrors the global ValidationPipe config in src/main.ts (same shape as
// events.e2e-spec.ts). Kept inline so this e2e doesn't depend on a shared
// factory module that doesn't exist on develop.
const buildValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
    skipMissingProperties: false,
    skipNullProperties: false,
    skipUndefinedProperties: false,
    exceptionFactory: (errors) => {
      const details = errors.map((error) => ({
        field: error.property,
        message: Object.values(error.constraints || {}).join(', '),
        value: error.value,
      }));
      return new HttpException(
        { message: 'Validation failed', details },
        HttpStatus.BAD_REQUEST,
      );
    },
  });

describe('ContactEvents listing (e2e)', () => {
  let app: INestApplication<App>;
  const contactEventsServiceStub = {
    list: jest.fn(),
  };

  beforeAll(async () => {
    // NOTE: We do NOT register BearerAuthGuard here — same rationale as
    // events.e2e-spec.ts (wiring it as APP_GUARD would force the DI container
    // to resolve real auth dependencies before any override could apply).
    // The auth contract for this route is asserted structurally at the bottom
    // of this file (no @Public() metadata).
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ContactEventsController],
      providers: [
        { provide: ContactEventsService, useValue: contactEventsServiceStub },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    contactEventsServiceStub.list.mockReset();
  });

  it('happy path: returns 200 with envelope + pagination from service', async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      contactId: 'contact-1',
      eventType: 'track',
      eventName: 'message.delivered',
      occurredAt: `2026-05-25T10:${String(59 - i).padStart(2, '0')}:00.000Z`,
      properties: { channel: 'whatsapp' },
      traits: {},
      messageId: `msg-${i}`,
    }));

    contactEventsServiceStub.list.mockResolvedValueOnce({
      events,
      pagination: { nextCursor: 'cursor-X', hasNext: true, limit: 50 },
    });

    const res = await request(app.getHttpServer()).get(
      '/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events',
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events).toHaveLength(50);
    expect(res.body.data.pagination).toEqual({
      nextCursor: 'cursor-X',
      hasNext: true,
      limit: 50,
    });
    expect(contactEventsServiceStub.list).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expect.objectContaining({}),
    );
  });

  it('forward pagination: passes cursor through to the service', async () => {
    contactEventsServiceStub.list.mockResolvedValueOnce({
      events: [],
      pagination: { nextCursor: null, hasNext: false, limit: 50 },
    });

    await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({ cursor: 'cursor-X' });

    expect(contactEventsServiceStub.list).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expect.objectContaining({ cursor: 'cursor-X' }),
    );
  });

  it('combined filters reach the service as parsed arrays/strings', async () => {
    contactEventsServiceStub.list.mockResolvedValueOnce({
      events: [],
      pagination: { nextCursor: null, hasNext: false, limit: 50 },
    });

    await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({
        eventType: 'track',
        eventName: 'message.delivered,message.read',
        channel: 'whatsapp',
        occurredAfter: '2026-04-01T00:00:00Z',
      });

    expect(contactEventsServiceStub.list).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expect.objectContaining({
        eventType: ['track'],
        eventName: ['message.delivered', 'message.read'],
        channel: 'whatsapp',
        occurredAfter: '2026-04-01T00:00:00Z',
      }),
    );
  });

  it('rejects limit=101 with 400 + error.details on `limit`', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({ limit: 101 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('Validation failed');
    const limitErr = res.body.error.details.find(
      (d: { field: string }) => d.field === 'limit',
    );
    expect(limitErr).toBeDefined();
    expect(limitErr.message).toMatch(/limit must not be greater than 100/);
    expect(contactEventsServiceStub.list).not.toHaveBeenCalled();
  });

  it('rejects eventType=journey (not in the ClickHouse Enum8) with 400 (F2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({ eventType: 'journey' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    const fieldErr = res.body.error.details.find(
      (d: { field: string }) => d.field === 'eventType',
    );
    expect(fieldErr).toBeDefined();
    expect(contactEventsServiceStub.list).not.toHaveBeenCalled();
  });

  it('invalid cursor: service throws BadRequestException → 400 with error.message', async () => {
    contactEventsServiceStub.list.mockImplementationOnce(() => {
      throw new BadRequestException('invalid cursor');
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({ cursor: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('invalid cursor');
  });

  it('rejects non-UUID `:id` path param with 400 before invoking the service (M1)', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/contacts/not-a-uuid/events',
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(contactEventsServiceStub.list).not.toHaveBeenCalled();
  });
});

// F5 — Exercise the cursor decode path end-to-end with the REAL service so
// that the controller → service → cursor-codec → BadRequestException →
// HttpExceptionFilter chain is verified by the e2e (not just unit specs).
describe('ContactEvents listing — real service (e2e)', () => {
  let app: INestApplication<App>;
  const clickhouseStub = {
    createQueryBuilder: jest.fn(),
    query: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ContactEventsController],
      providers: [
        ContactEventsService,
        { provide: ClickHouseService, useValue: clickhouseStub },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 400 "invalid cursor" without hitting ClickHouse when cursor is garbage', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events')
      .query({ cursor: 'not-base64-!!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('invalid cursor');
    expect(clickhouseStub.query).not.toHaveBeenCalled();
  });
});

// F7 — Structural guard: this controller must never be marked @Public(),
// otherwise the global BearerAuthGuard would let unauthenticated callers in.
describe('ContactEventsController auth contract', () => {
  it('does not declare @Public on the class or the list handler', () => {
    const reflector = new Reflector();
    const classMeta = reflector.get<boolean>(
      IS_PUBLIC_KEY,
      ContactEventsController,
    );
    const handlerMeta = reflector.get<boolean>(
      IS_PUBLIC_KEY,
      ContactEventsController.prototype.list,
    );
    expect(classMeta).toBeFalsy();
    expect(handlerMeta).toBeFalsy();
  });
});

// L1 — Behavioral auth proof: wire a fake APP_GUARD that returns false and
// verify the request is rejected with 401 before reaching the controller.
// Booting the real BearerAuthGuard would force resolving its CLS/Reflector/
// axios dependencies (same friction documented in events.e2e-spec.ts:19-24),
// so we exercise the contract with a minimal stand-in. This proves the route
// is guard-bound, complementing the structural @Public() assertion above.
describe('ContactEventsController honors the global APP_GUARD (L1)', () => {
  let app: INestApplication<App>;
  const denyAllGuard = { canActivate: jest.fn(() => false) };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ContactEventsController],
      providers: [
        { provide: ContactEventsService, useValue: { list: jest.fn() } },
        { provide: APP_GUARD, useValue: denyAllGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 403/401 when the global guard denies, never reaching the controller', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/contacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events',
    );

    expect([401, 403]).toContain(res.status);
    expect(denyAllGuard.canActivate).toHaveBeenCalled();
  });
});
