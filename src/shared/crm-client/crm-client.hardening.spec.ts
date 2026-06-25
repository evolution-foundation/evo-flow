/**
 * EVO-1205 — hardening of the generic CRM client path.
 *
 * Covers the 4 acceptance criteria:
 *  1. 503 → retries 3x with backoff (1s, 2s, 4s) before failing.
 *  2. 404 (4xx) → propagates immediately, no retry.
 *  3. Terminal failure → ContactsClientUnavailableException carrying
 *     correlationId + debug context (endpoint, lastStatusCode, totalLatencyMs).
 *  4. contacts_client_retry_total increments on each retry.
 *
 * Mocks `global.fetch` (native fetch, not axios) and drives the backoff with
 * jest fake timers.
 */
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { register } from 'prom-client';
import { ClsServiceManager } from 'nestjs-cls';

jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

process.env.EVOAI_CRM_BASE_URL = 'http://crm-test.local';
process.env.EVOAI_CRM_API_TOKEN = 'svc-token';
// Pin the real PRD schedule so the timing assertions are deterministic.
process.env.EVOAI_CRM_CLIENT_RETRY_BACKOFF_MS = '1000,2000,4000';
// Threshold 1: a single failing call opens the static breaker. Each test resets
// the breaker in beforeEach, so the per-test first call still runs to exhaustion
// while the circuit-open case can trip it in one shot.
process.env.EVOAI_CRM_CIRCUIT_THRESHOLD = '1';

import { CrmClientService } from './crm-client.service';
import { ContactsClientUnavailableException } from './contacts-client-unavailable.exception';
import { CORRELATION_CLS_KEY } from '../correlation/correlation.constants';

function buildFetchResponse(opts: {
  status: number;
  body?: any;
  headers?: Record<string, string>;
}): any {
  const headers = opts.headers ?? {};
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: `HTTP ${opts.status}`,
    headers: { get: (key: string) => headers[key] ?? null },
    json: async () => opts.body,
    text: async () =>
      typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  };
}

async function counterTotal(name: string): Promise<number> {
  const metric = register.getSingleMetric(name) as any;
  if (!metric) return 0;
  const data = await metric.get();
  return data.values.reduce((sum: number, v: any) => sum + v.value, 0);
}

describe('CrmClientService — generic-path hardening (EVO-1205)', () => {
  let service: CrmClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    CrmClientService.clearCacheForTests();
    CrmClientService.resetCircuitBreakerForTests();
    register.resetMetrics();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    service = new CrmClientService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('AC1: 503 → retries 3x with backoff (1s, 2s, 4s) then throws', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(
      buildFetchResponse({ status: 503, body: { error: 'down' } }),
    );

    const beforeTerminal = await counterTotal(
      'contacts_client_terminal_failure_total',
    );
    const promise = service
      .get('/api/v1/contacts/x', { noCache: true })
      .catch((e) => e);

    // Each backoff window unlocks exactly one more attempt — proving the
    // schedule is 1s → 2s → 4s (a different order would shift these counts).
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const error = await promise;
    expect(error).toBeInstanceOf(ContactsClientUnavailableException);
    // Terminal-failure counter increments once on exhaustion.
    const afterTerminal = await counterTotal(
      'contacts_client_terminal_failure_total',
    );
    expect(afterTerminal - beforeTerminal).toBe(1);
  });

  it('AC2: 404 on a write → throws NotFoundException immediately, no retry', async () => {
    fetchMock.mockResolvedValue(buildFetchResponse({ status: 404, body: {} }));

    await expect(
      service.patch('/api/v1/contacts/missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('M3: timeout (AbortError) increments timeout_total and is retried as timeout', async () => {
    jest.useFakeTimers();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValue(abortErr);

    const beforeTimeout = await counterTotal('contacts_client_timeout_total');
    const beforeRetry = await counterTotal('contacts_client_retry_total');

    const promise = service
      .get('/api/v1/contacts/x', { noCache: true })
      .catch((e) => e);
    await jest.advanceTimersByTimeAsync(7000);
    const error = await promise;

    expect(error).toBeInstanceOf(ContactsClientUnavailableException);
    expect((error as ContactsClientUnavailableException).reason).toBe(
      'timeout',
    );
    // 4 attempts all abort → 4 timeout increments; 3 of them trigger a retry.
    const afterTimeout = await counterTotal('contacts_client_timeout_total');
    const afterRetry = await counterTotal('contacts_client_retry_total');
    expect(afterTimeout - beforeTimeout).toBe(4);
    expect(afterRetry - beforeRetry).toBe(3);
  });

  it('AC2: 404 on a GET → returns null, no retry', async () => {
    fetchMock.mockResolvedValue(buildFetchResponse({ status: 404, body: {} }));

    const result = await service.get('/api/v1/contacts/missing', {
      noCache: true,
    });
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC3: terminal failure carries correlationId + endpoint + lastStatusCode + totalLatencyMs', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(buildFetchResponse({ status: 500, body: {} }));

    const cls = ClsServiceManager.getClsService();
    const run = cls.run(async () => {
      cls.set(CORRELATION_CLS_KEY, 'corr-abc-123');
      return service
        .post('/api/v1/contacts/x/labels', { labels: ['vip'] })
        .catch((e) => e);
    });

    await jest.advanceTimersByTimeAsync(7000);
    const error = await run;

    expect(error).toBeInstanceOf(ContactsClientUnavailableException);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const e = error as ContactsClientUnavailableException;
    expect(e.correlationId).toBe('corr-abc-123');
    expect(e.endpoint).toBe('POST /api/v1/contacts/x/labels');
    expect(e.lastStatusCode).toBe(500);
    expect(e.reason).toBe('server_error');
    expect(typeof e.totalLatencyMs).toBe('number');
    expect(e.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('AC3: circuit-open short-circuits with the same exception type', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(buildFetchResponse({ status: 500, body: {} }));

    // First failing call exhausts retries and trips the breaker (threshold=1).
    const first = service
      .get('/api/v1/contacts/x', { noCache: true })
      .catch((e) => e);
    await jest.advanceTimersByTimeAsync(7000);
    await first;

    // Next call short-circuits (no new fetch) with the rich exception.
    const callsBefore = fetchMock.mock.calls.length;
    const second = await service
      .get('/api/v1/contacts/y', { noCache: true })
      .catch((e) => e);

    expect(second).toBeInstanceOf(ContactsClientUnavailableException);
    expect((second as ContactsClientUnavailableException).reason).toBe(
      'circuit_open',
    );
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  // ==========================================================================
  // EVO-1918 — 404 (and the non-breaking 4xx class) must NOT open the breaker.
  //
  // The breaker threshold is pinned to 1 in this suite, so if any single 404
  // counted as a failure the circuit would open immediately and the NEXT call
  // (a valid contact) would short-circuit with `circuit_open`. Asserting that
  // the valid call still reaches fetch and succeeds proves the breaker stayed
  // CLOSED across the 404 storm.
  // ==========================================================================
  describe('EVO-1918: 404 / 4xx do not open the circuit breaker', () => {
    it('a storm of GET 404s keeps the breaker closed; valid contact still resolves', async () => {
      // 10 consecutive 404s (unsynced contacts) ...
      for (let i = 0; i < 10; i++) {
        fetchMock.mockResolvedValueOnce(
          buildFetchResponse({ status: 404, body: {} }),
        );
        const result = await service.get(`/api/v1/contacts/missing-${i}`, {
          noCache: true,
        });
        expect(result).toBeNull();
      }
      // No retries, no terminal failures were recorded for the 404s.
      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(
        await counterTotal('contacts_client_terminal_failure_total'),
      ).toBe(0);

      // ... a valid contact afterwards still hits the CRM and succeeds.
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: { id: 'ada', name: 'Ada' } }),
      );
      const ok = await service.get<any>('/api/v1/contacts/ada', {
        noCache: true,
      });
      expect(ok).toEqual({ id: 'ada', name: 'Ada' });
      expect(fetchMock).toHaveBeenCalledTimes(11);
    });

    it('a storm of write 404s (NotFound) keeps the breaker closed; valid write still resolves', async () => {
      for (let i = 0; i < 10; i++) {
        fetchMock.mockResolvedValueOnce(
          buildFetchResponse({ status: 404, body: {} }),
        );
        await expect(
          service.patch(`/api/v1/contacts/missing-${i}`, { labels: [] }),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(
        await counterTotal('contacts_client_terminal_failure_total'),
      ).toBe(0);

      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 204 }),
      );
      await expect(
        service.patch('/api/v1/contacts/ada', { labels: [] }),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(11);
    });

    it('other non-breaking 4xx (401, 422) also keep the breaker closed', async () => {
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 401, body: {} }),
      );
      await expect(
        service.get('/api/v1/contacts/x', { noCache: true }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 422, body: { errors: ['bad'] } }),
      );
      await expect(
        service.patch('/api/v1/contacts/x', { email: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Breaker still closed: no terminal failures, and a valid call goes through.
      expect(
        await counterTotal('contacts_client_terminal_failure_total'),
      ).toBe(0);
      fetchMock.mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: { id: 'ada' } }),
      );
      const ok = await service.get<any>('/api/v1/contacts/ada', {
        noCache: true,
      });
      expect(ok).toEqual({ id: 'ada' });
    });

    it('5xx still opens the breaker (regression guard for the real availability path)', async () => {
      jest.useFakeTimers();
      // threshold=1 → one exhausted 5xx call trips the circuit.
      fetchMock.mockResolvedValue(
        buildFetchResponse({ status: 500, body: {} }),
      );
      const first = service
        .get('/api/v1/contacts/x', { noCache: true })
        .catch((e) => e);
      await jest.advanceTimersByTimeAsync(7000);
      await first;

      const callsBefore = fetchMock.mock.calls.length;
      const second = await service
        .get('/api/v1/contacts/y', { noCache: true })
        .catch((e) => e);
      expect(second).toBeInstanceOf(ContactsClientUnavailableException);
      expect((second as ContactsClientUnavailableException).reason).toBe(
        'circuit_open',
      );
      // No new fetch — the breaker short-circuited.
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });
  });

  it('AC4: contacts_client_retry_total increments on retry', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(buildFetchResponse({ status: 503, body: {} }))
      .mockResolvedValueOnce(
        buildFetchResponse({ status: 200, body: { id: 'ok' } }),
      );

    const before = await counterTotal('contacts_client_retry_total');

    const promise = service.get<any>('/api/v1/contacts/x', { noCache: true });
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const after = await counterTotal('contacts_client_retry_total');

    expect(result).toEqual({ id: 'ok' });
    expect(after - before).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
