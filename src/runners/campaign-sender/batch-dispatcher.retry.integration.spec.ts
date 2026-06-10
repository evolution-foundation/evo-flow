import * as http from 'http';
import type { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { CrmInboxDispatcher } from '../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';
import { BatchDispatcherService } from './services/batch-dispatcher.service';
import { MessageTemplate } from '../../shared/entities/message-template.entity';
import type { HydratedContact } from '../../shared/crm-client/types/contact';

/**
 * Story 4.5's E2E smoke as a repeatable spec: a REAL HTTP server answers
 * 503, 503, 200 and the REAL CrmInboxDispatcher + BatchDispatcherService
 * stack (only db/rate-limiter/logger stubbed) must deliver after 2 backoff
 * retries with measurable exponential timing.
 */
describe('BatchDispatcherService retry integration (EVO-1219)', () => {
  let server: http.Server;
  let baseUrl: string;
  let statuses: number[];
  let hits: number;

  const template = {
    id: 'tpl-1',
    name: 'welcome',
    content: 'Hi {contact.name}',
    language: 'pt_BR',
    category: 'marketing',
    variables: [],
  } as unknown as MessageTemplate;

  const contact: HydratedContact = {
    id: 'contact-1',
    name: 'Ana',
    blocked: false,
    customAttributes: {},
    additionalAttributes: {},
  };

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      hits++;
      const status = statuses.shift() ?? 200;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(
        status === 200
          ? JSON.stringify({ id: 'conv-1', messages: [{ id: 'msg-1' }] })
          : JSON.stringify({ error: 'upstream unavailable' }),
      );
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  const RETRY_ENVS = [
    'DISPATCH_RETRY_COUNT',
    'DISPATCH_BACKOFF_BASE_MS',
    'DISPATCH_BACKOFF_CAP_MS',
  ] as const;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    hits = 0;
    statuses = [];
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    for (const name of RETRY_ENVS) {
      envBackup[name] = process.env[name];
      delete process.env[name];
    }
    process.env.DISPATCH_BACKOFF_BASE_MS = '200';
    process.env.DISPATCH_BACKOFF_CAP_MS = '30000';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const buildService = (): BatchDispatcherService => {
    const config = {
      get: (key: string) =>
        key === 'EVOAI_CRM_BASE_URL'
          ? baseUrl
          : key === 'EVOAI_CRM_API_TOKEN'
            ? 'test-token'
            : undefined,
    } as unknown as ConfigService;

    return new BatchDispatcherService(
      { getRepository: () => ({ findOne: jest.fn() }) } as never,
      new CrmInboxDispatcher(config),
      { acquire: jest.fn().mockResolvedValue(true) } as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    );
  };

  it('delivers after two 503s with exponential backoff timing (503,503,200)', async () => {
    statuses = [503, 503];

    const started = Date.now();
    const outcome = await buildService().dispatch({
      campaignId: 'camp-1',
      inboxId: 'inbox-1',
      template,
      contact,
    });
    const elapsed = Date.now() - started;

    expect(outcome.kind).toBe('sent');
    if (outcome.kind === 'sent') {
      expect(outcome.result.conversationId).toBe('conv-1');
      expect(outcome.result.messageId).toBe('msg-1');
    }
    expect(hits).toBe(3);
    // Two backoffs: 200ms + 400ms = 600ms minimum (real sleeps, real HTTP).
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(2500);
  });

  it('fails fast on a real 4xx without retrying', async () => {
    statuses = [422];

    const outcome = await buildService().dispatch({
      campaignId: 'camp-1',
      inboxId: 'inbox-1',
      template,
      contact,
    });

    expect(hits).toBe(1);
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: 'http_4xx: 422',
      statusCode: 422,
    });
  });
});
