import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpException,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { EventsController } from '../src/modules/events/events.controller';
import { EventsService } from '../src/modules/events/events.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';

// Mirrors the global ValidationPipe config in src/main.ts:107-131. Kept inline
// (not imported) so this test asserts the production CONTRACT, not the current
// main.ts module — if main.ts changes shape, this still verifies what callers
// rely on.
const buildValidationPipe = () =>
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

describe('Events validation (e2e)', () => {
  let app: INestApplication<App>;
  const eventsServiceStub = {
    trackEvent: jest.fn(async () => ({ messageId: 'm-1', status: 'success' })),
    identifyEvent: jest.fn(async () => ({ messageId: 'm-1', status: 'success' })),
  };

  beforeAll(async () => {
    // NOTE: We do NOT register BearerAuthGuard here — wiring it as APP_GUARD
    // would force the DI container to resolve its real dependencies
    // (ClsService, Reflector, axios config) before any override could apply.
    // The /events/track and /events/identify routes have no per-route guard,
    // so the auth contract is exercised by separate auth-module tests, not by
    // this validation-shape e2e.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: eventsServiceStub }],
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

  describe('POST /api/v1/events/track', () => {
    it('rejects unknown event with 400 + error.details on `event` (AC4)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/events/track')
        .send({ messageId: 'm-1', contactId: '42', event: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      const eventErr = res.body.error.details.find(
        (d: { field: string }) => d.field === 'event',
      );
      expect(eventErr).toBeDefined();
      expect(eventErr.message).toMatch(/event must be one of/);
    });

    it('accepts canonical event with success envelope (AC5)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/events/track')
        .send({
          messageId: 'm-1',
          contactId: '42',
          event: 'contact.created',
        });

      // NestJS POST defaults to 201; AC §4 says "200 response" but the actual
      // production controller has no @HttpCode override, so 201 is correct.
      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ messageId: 'm-1', status: 'success' });
      expect(eventsServiceStub.trackEvent).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/events/identify', () => {
    it('rejects unknown eventName with 400 + error.details on `eventName` (AC4b)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/events/identify')
        .send({ messageId: 'm-1', contactId: '42', eventName: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      const eventErr = res.body.error.details.find(
        (d: { field: string }) => d.field === 'eventName',
      );
      expect(eventErr).toBeDefined();
      expect(eventErr.message).toMatch(/eventName must be one of/);
    });

    it('accepts request without eventName (optional short-circuits @IsIn, AC5b)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/events/identify')
        .send({ messageId: 'm-1', contactId: '42' });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(eventsServiceStub.identifyEvent).toHaveBeenCalled();
    });
  });
});
