import { Counter, register } from 'prom-client';
import { BatchDispatcherService } from './batch-dispatcher.service';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import { RateLimitedError } from '../errors/rate-limited.error';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import type { HydratedContact } from '../../../shared/crm-client/types/contact';

const RETRIES_METRIC = 'evo_flow_dispatch_retries_total';
const TERMINAL_METRIC = 'evo_flow_dispatch_terminal_failures_total';

const RETRY_ENVS = [
  'DISPATCH_RETRY_COUNT',
  'DISPATCH_BACKOFF_BASE_MS',
  'DISPATCH_BACKOFF_CAP_MS',
] as const;

const template = {
  id: 'tpl-1',
  name: 'welcome',
  content: 'Hi {contact.name}, your plan is {{contact.plan}}',
  language: 'pt_BR',
  category: 'marketing',
  variables: [{ key: 'plan' }],
} as unknown as MessageTemplate;

const contact: HydratedContact = {
  id: 'contact-1',
  name: 'Ana',
  email: 'ana@example.com',
  phoneNumber: '+5511999999999',
  blocked: false,
  customAttributes: { plan: 'pro' },
  additionalAttributes: {},
};

const ok = { success: true, latencyMs: 5 };
const http = (statusCode: number) => ({
  success: false,
  statusCode,
  error: { code: String(statusCode), message: `CRM API error: ${statusCode}` },
  latencyMs: 5,
});
const networkError = {
  success: false,
  error: { code: 'DISPATCH_ERROR', message: 'fetch failed' },
  latencyMs: 5,
};

const metricValues = async (name: string) => {
  const metric = register.getSingleMetric(name) as Counter<string>;
  return (await metric.get()).values;
};

describe('BatchDispatcherService', () => {
  let service: BatchDispatcherService;
  let findOne: jest.Mock;
  let dispatch: jest.Mock;
  let acquire: jest.Mock;
  let log: jest.Mock;
  let warn: jest.Mock;
  const envBackup: Record<string, string | undefined> = {};

  const input = () => ({
    campaignId: 'camp-1',
    inboxId: 'inbox-1',
    template,
    contact,
  });

  beforeEach(() => {
    for (const name of RETRY_ENVS) {
      envBackup[name] = process.env[name];
      delete process.env[name];
    }
    // Fast backoffs by default; individual tests override for timing checks.
    process.env.DISPATCH_BACKOFF_BASE_MS = '20';
    process.env.DISPATCH_BACKOFF_CAP_MS = '40';

    // Fresh counters per test — the service get-or-creates on the global
    // prom-client register, which would otherwise accumulate across tests.
    register.removeSingleMetric(RETRIES_METRIC);
    register.removeSingleMetric(TERMINAL_METRIC);

    findOne = jest.fn();
    dispatch = jest.fn();
    acquire = jest.fn().mockResolvedValue(true);
    log = jest.fn();
    warn = jest.fn();
    const db = { getRepository: () => ({ findOne }) };
    service = new BatchDispatcherService(
      db as any,
      { dispatch } as any,
      { acquire } as any,
      { log, warn } as any,
    );
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('loadTemplate', () => {
    it('returns the template when it exists', async () => {
      findOne.mockResolvedValueOnce(template);

      await expect(service.loadTemplate('camp-1', 'tpl-1')).resolves.toBe(
        template,
      );
      expect(findOne).toHaveBeenCalledWith({ where: { id: 'tpl-1' } });
    });

    it('throws a terminal CampaignNotConfiguredError when missing', async () => {
      findOne.mockResolvedValueOnce(null);

      await expect(service.loadTemplate('camp-1', 'tpl-x')).rejects.toThrow(
        CampaignNotConfiguredError,
      );
    });
  });

  describe('dispatch', () => {
    it('delegates with rendered content, template params and transportRetries=1', async () => {
      dispatch.mockResolvedValueOnce(ok);

      const outcome = await service.dispatch(input());

      expect(outcome).toEqual({ kind: 'sent', result: ok });
      expect(dispatch).toHaveBeenCalledWith({
        contactId: 'contact-1',
        inboxId: 'inbox-1',
        content: 'Hi Ana, your plan is pro',
        campaignId: 'camp-1',
        templateParams: {
          name: 'welcome',
          category: 'marketing',
          language: 'pt_BR',
          processed_params: [{ key: 'plan' }],
        },
        transportRetries: 1,
      });
    });

    it('renders empty string for missing contact fields and attributes', async () => {
      dispatch.mockResolvedValueOnce(ok);
      const sparse: HydratedContact = {
        id: 'contact-2',
        name: '',
        blocked: false,
        customAttributes: { plan: null },
        additionalAttributes: {},
      };

      await service.dispatch({ ...input(), contact: sparse });

      const [[arg]] = dispatch.mock.calls as [[{ content: string }]];
      expect(arg.content).toBe('Hi , your plan is ');
    });
  });

  describe('retry policy (EVO-1219)', () => {
    // AC2: 4xx is a permanent failure — one attempt, no retry.
    it('fails immediately on 4xx with reason http_4xx and a terminal metric', async () => {
      dispatch.mockResolvedValue(http(400));

      const outcome = await service.dispatch(input());

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({
        kind: 'failed',
        reason: 'http_4xx: 400',
        statusCode: 400,
      });
      const values = await metricValues(TERMINAL_METRIC);
      expect(values).toHaveLength(1);
      expect(values[0].labels).toMatchObject({ reason: 'http_4xx' });
    });

    // AC3: 503 then 200 — success after 1 retry, attempt=1 counted.
    it('retries a 503 and succeeds, counting dispatch_retries_total{attempt=1}', async () => {
      dispatch.mockResolvedValueOnce(http(503)).mockResolvedValueOnce(ok);

      const outcome = await service.dispatch(input());

      expect(outcome).toEqual({ kind: 'sent', result: ok });
      expect(dispatch).toHaveBeenCalledTimes(2);
      // Each attempt consumes its own rate-limit token (4.4 contract).
      expect(acquire).toHaveBeenCalledTimes(2);
      const values = await metricValues(RETRIES_METRIC);
      expect(values).toHaveLength(1);
      expect(values[0].labels).toMatchObject({ attempt: '1' });
      expect(values[0].value).toBe(1);
    });

    // AC1: exhausts DISPATCH_RETRY_COUNT (default 3 retries → 4 attempts),
    // aggregating every attempt's error code, with capped exponential backoff.
    it('exhausts retries on persistent 5xx aggregating all attempt errors', async () => {
      dispatch
        .mockResolvedValueOnce(http(503))
        .mockResolvedValueOnce(networkError)
        .mockResolvedValueOnce(http(504))
        .mockResolvedValueOnce(http(503));

      const outcome = await service.dispatch(input());

      expect(dispatch).toHaveBeenCalledTimes(4);
      expect(outcome).toMatchObject({
        kind: 'failed',
        reason:
          'dispatch_exhausted_retries: ["503","DISPATCH_ERROR","504","503"]',
      });
      // Backoff sequence respects base*2^n capped at DISPATCH_BACKOFF_CAP_MS.
      const backoffs = warn.mock.calls
        .filter(([msg]) => msg === 'dispatch retry scheduled')
        .map(([, meta]) => (meta as { backoffMs: number }).backoffMs);
      expect(backoffs).toEqual([20, 40, 40]);
      const terminal = await metricValues(TERMINAL_METRIC);
      expect(terminal[0].labels).toMatchObject({ reason: 'exhausted_retries' });
      const retries = await metricValues(RETRIES_METRIC);
      expect(retries.map((v) => v.labels.attempt).sort()).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    // AC4: pause/stop noticed during the backoff wait aborts without failing.
    it('aborts mid-backoff when shouldAbort reports the campaign stopped', async () => {
      dispatch.mockResolvedValue(http(503));
      const shouldAbort = jest
        .fn<Promise<'stopped' | null>, []>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue('stopped');

      const outcome = await service.dispatch({ ...input(), shouldAbort });

      expect(outcome).toEqual({ kind: 'aborted', abortReason: 'stopped' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'aborted: campaign stopped during retry',
        expect.objectContaining({ campaignId: 'camp-1', attempt: 1 }),
      );
      const terminal = await metricValues(TERMINAL_METRIC);
      expect(terminal).toEqual([]);
    });

    // AC5: DISPATCH_RETRY_COUNT=2 + base 500ms → FAILED after ~0.5s + 1s.
    it('honors DISPATCH_RETRY_COUNT and DISPATCH_BACKOFF_BASE_MS timing', async () => {
      process.env.DISPATCH_RETRY_COUNT = '2';
      process.env.DISPATCH_BACKOFF_BASE_MS = '500';
      process.env.DISPATCH_BACKOFF_CAP_MS = '30000';
      dispatch.mockResolvedValue(http(503));

      const started = Date.now();
      const outcome = await service.dispatch(input());
      const elapsed = Date.now() - started;

      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(outcome).toMatchObject({
        kind: 'failed',
        reason: 'dispatch_exhausted_retries: ["503","503","503"]',
      });
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2600);
    });

    it('honors DISPATCH_RETRY_COUNT=0 as a no-retries override', async () => {
      process.env.DISPATCH_RETRY_COUNT = '0';
      dispatch.mockResolvedValue(http(503));

      const outcome = await service.dispatch(input());

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({
        kind: 'failed',
        reason: 'dispatch_exhausted_retries: ["503"]',
      });
      const retries = await metricValues(RETRIES_METRIC);
      expect(retries).toEqual([]);
    });

    it('propagates RateLimitedError from a retry attempt (page requeues)', async () => {
      dispatch.mockResolvedValue(http(503));
      acquire.mockResolvedValueOnce(true).mockResolvedValue(false);

      await expect(service.dispatch(input())).rejects.toThrow(RateLimitedError);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limiting (EVO-1218)', () => {
    it('acquires exactly one token on the happy path without retry logs', async () => {
      dispatch.mockResolvedValueOnce(ok);

      await service.dispatch(input());

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('retries after a blocked acquire and logs "rate-limit retry 1: acquired"', async () => {
      acquire.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      dispatch.mockResolvedValueOnce(ok);

      await service.dispatch(input());

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith('rate-limit retry 1: acquired', {
        inboxId: 'inbox-1',
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('throws RateLimitedError and logs "rate-limited: requeued" after 4 blocked attempts', async () => {
      acquire.mockResolvedValue(false);

      await expect(service.dispatch(input())).rejects.toThrow(RateLimitedError);

      expect(acquire).toHaveBeenCalledTimes(4);
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('rate-limited: requeued', {
        inboxId: 'inbox-1',
        attempts: 4,
      });
    });
  });
});
