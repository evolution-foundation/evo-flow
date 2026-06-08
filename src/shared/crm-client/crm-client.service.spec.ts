/**
 * Unit tests for CrmClientService.
 *
 * Mocks `global.fetch` (the existing service uses native fetch, not axios).
 * Resets the static cache + circuit breaker before each test so they don't
 * leak across cases.
 */
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

// Silence @temporalio/activity log calls under unit-test (no activity context).
jest.mock('@temporalio/activity', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

process.env.EVOAI_CRM_BASE_URL = 'http://crm-test.local';
process.env.EVOAI_CRM_API_TOKEN = 'svc-token';
process.env.EVOAI_CRM_RETRY_MAX_ATTEMPTS = '2';
process.env.EVOAI_CRM_CIRCUIT_THRESHOLD = '3';
// Generic-path hardening (EVO-1205): single zero-delay retry keeps these
// status-mapping cases fast. The (1s, 2s, 4s) schedule + the dedicated
// ContactsClientUnavailableException contract are covered in
// crm-client.hardening.spec.ts.
process.env.EVOAI_CRM_CLIENT_RETRY_BACKOFF_MS = '0';

import { CrmClientService } from './crm-client.service';

function buildFetchResponse(opts: {
  ok?: boolean;
  status: number;
  body?: any;
  headers?: Record<string, string>;
}): any {
  const headers = opts.headers ?? {};
  return {
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    status: opts.status,
    statusText: `HTTP ${opts.status}`,
    headers: {
      get: (key: string) => headers[key] ?? null,
    },
    json: async () => opts.body,
    text: async () =>
      typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  };
}

describe('CrmClientService', () => {
  let service: CrmClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    CrmClientService.clearCacheForTests();
    CrmClientService.resetCircuitBreakerForTests();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    service = new CrmClientService();
  });

  describe('generic GET — caching', () => {
    it('caches GET on success and returns cached value on second call', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: { id: 'abc' } }),
      );

      const a = await service.get<any>('/api/v1/contacts/abc');
      const b = await service.get<any>('/api/v1/contacts/abc');

      expect(a).toEqual({ id: 'abc' });
      expect(b).toEqual({ id: 'abc' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache when noCache=true', async () => {
      fetchMock
        .mockResolvedValueOnce(
          buildFetchResponse({ status: 200, body: { id: 'a' } }),
        )
        .mockResolvedValueOnce(
          buildFetchResponse({ status: 200, body: { id: 'a-v2' } }),
        );

      await service.get<any>('/api/v1/contacts/a');
      const fresh = await service.get<any>('/api/v1/contacts/a', {
        noCache: true,
      });

      expect(fresh).toEqual({ id: 'a-v2' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('status mapping', () => {
    it('returns null on 404 for GET', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 404, body: { error: 'not found' } }),
      );

      const result = await service.get<any>('/api/v1/contacts/missing');
      expect(result).toBeNull();
    });

    it('throws NotFoundException on 404 for PATCH (write)', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 404, body: {} }),
      );

      await expect(
        service.patch('/api/v1/contacts/missing', { foo: 'bar' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws UnauthorizedException on 401', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 401, body: {} }),
      );

      await expect(service.get('/api/v1/contacts/x')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws BadRequestException on 422 with body', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({
          status: 422,
          body: { errors: ['invalid email'] },
        }),
      );

      await expect(
        service.post('/api/v1/contacts/x/labels', { labels: ['vip'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws ServiceUnavailableException on 5xx after exhausting retries', async () => {
      fetchMock.mockResolvedValue(
        buildFetchResponse({ status: 500, body: { error: 'boom' } }),
      );

      await expect(service.get('/api/v1/contacts/x')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // 2 attempts (retryMaxAttempts=2)
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('circuit breaker', () => {
    it('opens after consecutive failures and short-circuits next call', async () => {
      fetchMock.mockResolvedValue(
        buildFetchResponse({ status: 500, body: {} }),
      );

      // 3 calls, each retries twice -> hits threshold of 3 consecutive failures
      // (CircuitBreaker.consecutiveFailures bumps per execute() failure, not per fetch).
      for (let i = 0; i < 3; i++) {
        await expect(
          service.get(`/api/v1/contacts/${i}`),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
      }

      const callsBefore = fetchMock.mock.calls.length;

      // Fourth call: circuit should be open — no fetch made.
      await expect(service.get('/api/v1/contacts/4')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('does NOT trip circuit on terminal 4xx (server is healthy)', async () => {
      fetchMock.mockResolvedValue(
        buildFetchResponse({ status: 401, body: {} }),
      );

      // 5 consecutive 401s — circuit must stay closed.
      for (let i = 0; i < 5; i++) {
        await expect(service.get('/api/v1/contacts/x')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
    });
  });

  describe('Retry-After honored on 429', () => {
    it('waits Retry-After seconds before retrying', async () => {
      jest.useFakeTimers();

      fetchMock
        .mockResolvedValueOnce(
          buildFetchResponse({
            status: 429,
            body: {},
            headers: { 'Retry-After': '2' },
          }),
        )
        .mockResolvedValueOnce(
          buildFetchResponse({ status: 200, body: { id: 'ok' } }),
        );

      const promise = service.get<any>('/api/v1/contacts/x', { noCache: true });

      // Drain the 2_000ms timer used between retries.
      await jest.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      expect(result).toEqual({ id: 'ok' });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });

  describe('auth headers', () => {
    it('uses X-Service-Token header by default (s2s)', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: {} }),
      );

      await service.get('/api/v1/contacts/abc');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['X-Service-Token']).toBe('svc-token');
      expect(init.headers['Authorization']).toBeUndefined();
    });

    it('uses Authorization: Bearer when opts.authToken is provided', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: {} }),
      );

      await service.get('/api/v1/contacts/abc', { authToken: 'usr-jwt' });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer usr-jwt');
      expect(init.headers['X-Service-Token']).toBeUndefined();
    });

    it('propagates transactionId as X-Request-Id when provided via opts', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: {} }),
      );

      await service.get('/api/v1/contacts/abc', {
        transactionId: 'tx-xyz',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['X-Request-Id']).toBe('tx-xyz');
    });
  });
});
