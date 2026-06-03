import { Request, Response } from 'express';
import { WebhooksController } from './webhooks.controller';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { WebhookIntakeService } from '../services/webhook-intake.service';

interface ResMock {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
}

function mockRes(): ResMock {
  const res: ResMock = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.setHeader.mockReturnValue(res);
  return res;
}

function mockReq(
  body: Buffer | undefined,
  contentType: string,
  splat: string | string[] = 'evolution-api',
): Request {
  const pathLabel = Array.isArray(splat) ? splat.join('/') : splat;
  return {
    body,
    rawBody: body,
    headers: { 'content-type': contentType },
    params: { splat },
    path: `/webhooks/${pathLabel}`,
  } as unknown as Request;
}

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let intake: { intake: jest.Mock };

  beforeEach(() => {
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    intake = { intake: jest.fn().mockResolvedValue(undefined) };
    controller = new WebhooksController(
      logger as unknown as CustomLoggerService,
      intake as unknown as WebhookIntakeService,
    );
  });

  it('returns 200 { ok: true } for a valid JSON payload (AC1)', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('{"foo":"bar"}'), 'application/json'),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(intake.intake).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'evolution-api',
        parsed: { foo: 'bar' },
      }),
    );
  });

  it('returns 400 { error: malformed_payload } for invalid JSON (AC2)', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('malformed{{'), 'application/json'),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'malformed_payload' });
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('accepts text/plain payloads as-is (200)', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('anything goes here'), 'text/plain'),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(intake.intake).toHaveBeenCalledWith(
      expect.objectContaining({ parsed: 'anything goes here' }),
    );
  });

  it('accepts form-urlencoded payloads (200)', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('a=1&b=2'), 'application/x-www-form-urlencoded'),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(intake.intake).toHaveBeenCalledWith(
      expect.objectContaining({ parsed: { a: '1', b: '2' } }),
    );
  });

  it('treats an empty body as a parseable no-op (200)', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(undefined, 'application/json'),
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('returns 503 + Retry-After when intake fails (broker publish prep)', async () => {
    intake.intake.mockRejectedValueOnce(new Error('broker down'));
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('{"foo":"bar"}'), 'application/json'),
      res as unknown as Response,
    );

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '10');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'service_unavailable' });
  });

  it('joins multi-segment catch-all paths into the platform label', async () => {
    const res = mockRes();
    await controller.receive(
      mockReq(Buffer.from('{}'), 'application/json', [
        'evolution-api',
        'instance-1',
      ]),
      res as unknown as Response,
    );

    expect(intake.intake).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'evolution-api/instance-1' }),
    );
  });
});
