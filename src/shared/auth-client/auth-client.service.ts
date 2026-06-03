import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { ClsService } from 'nestjs-cls';
import {
  CircuitBreaker,
  CircuitBreakerState,
} from '../../modules/processing/resilience/circuit-breaker';
import { getAuthClientConfig } from './auth-client.config';
import type { UserDto } from './types/user';

interface RequestOpts {
  authToken?: string;
  noCache?: boolean;
  timeoutMs?: number;
  transactionId?: string;
}

/**
 * AuthClientService — REST client for evo-auth-service-community.
 *
 * Used by `UsersService.findOne` (and any future evo-flow code that needs
 * to look up a user by id). Mirrors `CrmClientService` (LRU cache 30s on
 * GETs, circuit breaker, status mapping) but with an independent breaker
 * so an auth-service outage does not affect CRM calls (and vice versa).
 *
 * Uses axios (parallel with BearerAuthGuard) — separate codepath, separate
 * breaker.
 *
 * Auth (s2s default): `Authorization: Bearer <EVO_AUTH_API_TOKEN>` (falls
 * back to `AUTH_APIKEY_INTEGRATION_LOCAL` if dedicated env var absent).
 * If `opts.authToken` is provided, that user token is used instead.
 */
@Injectable()
export class AuthClientService {
  private static readonly cache = new LRUCache<string, any>({
    max: 10_000,
    ttl: getAuthClientConfig().cacheTtlMs,
  });

  private static readonly circuitBreaker = new CircuitBreaker('auth-client', {
    failureThreshold: getAuthClientConfig().circuitThreshold,
    recoveryTimeout: getAuthClientConfig().circuitRecoveryMs,
    timeout: 300_000,
  });

  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly axios: AxiosInstance;
  private readonly cls?: ClsService;

  constructor(cls?: ClsService) {
    const cfg = getAuthClientConfig();
    this.baseUrl = cfg.baseUrl;
    this.serviceToken = cfg.apiToken;
    this.timeoutMs = cfg.timeoutMs;
    this.cls = cls;

    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      validateStatus: () => true,
    });
  }

  async getUserById(
    userId: string,
    opts?: RequestOpts,
  ): Promise<UserDto | null> {
    return this.requestGet<UserDto>(`/api/v1/users/${userId}`, opts);
  }

  private async requestGet<T>(
    path: string,
    opts?: RequestOpts,
  ): Promise<T | null> {
    const cacheKey = !opts?.noCache
      ? this.buildCacheKey('GET', path, opts?.authToken)
      : null;
    if (cacheKey) {
      const cached = AuthClientService.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached as T;
      }
    }

    if (
      AuthClientService.circuitBreaker.getStats().state ===
      CircuitBreakerState.OPEN
    ) {
      throw new ServiceUnavailableException(
        'auth-service unavailable (circuit open)',
      );
    }

    let response: any;
    try {
      response = await AuthClientService.circuitBreaker.execute(async () => {
        const r = await this.axios.get(path, {
          headers: this.buildHeaders(opts),
          timeout: opts?.timeoutMs ?? this.timeoutMs,
        });
        if (r.status >= 500) {
          throw new Error(`auth-service error (${r.status})`);
        }
        return r;
      });
    } catch (err: any) {
      if (axios.isAxiosError(err) || err instanceof AxiosError) {
        throw new ServiceUnavailableException(
          `auth-service unreachable: ${err.message}`,
        );
      }
      throw new ServiceUnavailableException(
        `auth-service request failed: ${err?.message ?? String(err)}`,
      );
    }

    if (response.status >= 200 && response.status < 300) {
      const data = response.data?.data ?? response.data;
      if (cacheKey) {
        AuthClientService.cache.set(cacheKey, data);
      }
      return data as T;
    }

    if (response.status === 404) {
      return null;
    }
    if (response.status === 401) {
      throw new UnauthorizedException('auth-service rejected token (401)');
    }
    if (response.status === 422) {
      throw new BadRequestException(response.data);
    }
    // Other 4xx — surface as BadRequest.
    throw new BadRequestException(
      `auth-service request failed (${response.status})`,
    );
  }

  private buildHeaders(opts?: RequestOpts): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (opts?.authToken) {
      headers['Authorization'] = `Bearer ${opts.authToken}`;
    } else if (this.serviceToken) {
      headers['Authorization'] = `Bearer ${this.serviceToken}`;
    }

    const transactionId = opts?.transactionId ?? this.readTransactionId();
    if (transactionId) {
      headers['X-Request-Id'] = transactionId;
    }

    const correlationId = this.readCorrelationId();
    if (correlationId) {
      headers['X-Correlation-Id'] = correlationId;
    }

    return headers;
  }

  private readTransactionId(): string | undefined {
    if (!this.cls) return undefined;
    try {
      return this.cls.get<string>('transactionId');
    } catch {
      return undefined;
    }
  }

  private readCorrelationId(): string | undefined {
    if (!this.cls) return undefined;
    try {
      return this.cls.get<string>('correlationId');
    } catch {
      return undefined;
    }
  }

  private buildCacheKey(
    method: string,
    path: string,
    authToken: string | undefined,
  ): string {
    const tokenSource = authToken ?? this.serviceToken ?? '';
    const tokenHash = createHash('sha256')
      .update(tokenSource)
      .digest('hex')
      .slice(0, 16);
    return createHash('sha256')
      .update(`${method}:${path}:${tokenHash}`)
      .digest('hex');
  }

  /** Suppress unused-import warning on NotFoundException (kept for parity). */
  static __nf_marker: typeof NotFoundException = NotFoundException;

  static resetCircuitBreakerForTests(): void {
    AuthClientService.circuitBreaker.reset();
  }

  static clearCacheForTests(): void {
    AuthClientService.cache.clear();
  }
}
