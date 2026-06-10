import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { ClsService } from 'nestjs-cls';
import {
  CircuitBreaker,
  CircuitBreakerState,
} from '../../modules/processing/resilience/circuit-breaker';
import { getCrmClientConfig } from './crm-client.config';
import { ContactsClientUnavailableException } from './contacts-client-unavailable.exception';
import {
  contactsClientMetrics,
  type ContactsClientTerminalReason,
} from './contacts-client.metrics';
import { readCorrelationIdFromCls } from '../correlation/correlation.util';
import type { RequestOptions } from './types/responses';

export interface CrmApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface CrmConversationContext {
  conversationId: string;
  inboxId?: string;
}

/**
 * Wire shape of `template_params` accepted by the CRM messages endpoint
 * (Messages::MessageBuilder#process_template_content): the CRM resolves the
 * template by name+language on the conversation's channel and re-renders the
 * content server-side; providers (WhatsApp Cloud) use it for the Meta send.
 */
export interface CrmMessageTemplateParams {
  name: string;
  language?: string;
  category?: string;
  processed_params?: Record<string, unknown>;
}

/**
 * CrmClientService — REST client for evo-ai-crm-community (Rails).
 *
 * Promoted from `src/modules/temporal/activities/nodes/evoai/evo-ai-crm-base.service.ts`.
 * Existing temporal-node domain methods (assignAgent, sendMessage, etc.) are
 * preserved verbatim so the temporal nodes that `new CrmClientService()` still
 * work. New generic methods (`get<T>`, `post<T>`, `patch<T>`, `delete<T>`) are
 * added for the Q3 contacts/labels/custom-attributes consumers.
 *
 * Cache: LRU max=10_000, TTL=30s (configurable). Cache key =
 * `sha256(method:path:authTokenHash)`. Only GETs are cached; bypass with
 * `opts.noCache: true`.
 *
 * Circuit breaker: class-level static instance, threshold=5 consecutive
 * failures, recovery=60s. State shared across all `new CrmClientService()`
 * instantiations and DI-managed singletons.
 *
 * Generic-path hardening (EVO-1205): the generic get/post/patch/delete methods
 * enforce a 5s timeout and retry 5xx/network/429 up to 3 times with backoff
 * (1s, 2s, 4s). 4xx are never retried. On exhaustion they throw
 * `ContactsClientUnavailableException` (a 503 carrying correlationId + debug
 * context) and emit `contacts_client_*` Prometheus counters. See README.
 *
 * Status mapping (generic path):
 *  - 200/201/204 → returns data (and caches GET).
 *  - 404 GET → returns `null`.
 *  - 404 write → throws `NotFoundException`.
 *  - 401 → `UnauthorizedException`.
 *  - 422 → `BadRequestException` (with response body).
 *  - 429 → respects `Retry-After`; after exhausting retries → `ContactsClientUnavailableException`.
 *  - 5xx / network / timeout → retried, then → `ContactsClientUnavailableException`.
 *  - Circuit OPEN → `ContactsClientUnavailableException` immediately.
 *
 * Auth (s2s default): header `X-Service-Token: <EVOAI_CRM_API_TOKEN>` —
 * matches the wire format already in use by the existing temporal nodes.
 * If `opts.authToken` is provided, sends `Authorization: Bearer <token>`.
 *
 * Tracing: reads `transactionId` from CLS (or `opts.transactionId`) and
 * injects header `X-Request-Id`.
 */
@Injectable()
export class CrmClientService {
  // Class-level cache and circuit so static `new CrmClientService()` and the
  // DI-managed singleton share the same protections.
  private static readonly cache = new LRUCache<string, any>({
    max: 10_000,
    ttl: getCrmClientConfig().cacheTtlMs,
  });

  private static readonly circuitBreaker = new CircuitBreaker('crm-client', {
    failureThreshold: getCrmClientConfig().circuitThreshold,
    recoveryTimeout: getCrmClientConfig().circuitRecoveryMs,
    // We manage per-request timeouts via AbortController inside the loop,
    // and the loop may need >10s (retries + Retry-After). Use a generous
    // upper bound for the breaker-level timeout so it doesn't pre-empt
    // legitimate retry cycles.
    timeout: 300_000,
  });

  private static readonly logger = new Logger('CrmClientService');

  private readonly baseURL: string;
  private readonly serviceToken: string;
  private readonly timeout: number;
  private readonly genericTimeout: number;
  private readonly genericBackoffMs: number[];
  private readonly cls?: ClsService;

  constructor(cls?: ClsService) {
    const config = getCrmClientConfig();
    this.baseURL = config.baseUrl;
    this.serviceToken = config.apiToken;
    this.timeout = config.timeoutMs;
    this.genericTimeout = config.genericTimeoutMs;
    this.genericBackoffMs = config.genericRetryBackoffMs;
    this.cls = cls;

    CrmClientService.logger.log(
      `CrmClientService initialized ${JSON.stringify({
        baseURL: this.baseURL,
        hasServiceToken: !!this.serviceToken,
        serviceTokenLength: this.serviceToken.length,
        timeout: this.timeout,
      })}`,
    );

    if (!this.serviceToken) {
      throw new Error('EVOAI_CRM_API_TOKEN environment variable is required');
    }

    if (!this.baseURL) {
      throw new Error('EVOAI_CRM_BASE_URL environment variable is required');
    }
  }

  // ============================================================================
  // Generic methods (new — used by Q3 contacts/labels/custom-attributes clients)
  // ============================================================================

  async get<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.requestGeneric<T>('GET', path, undefined, opts);
  }

  async post<T>(
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const result = await this.requestGeneric<T>('POST', path, body, opts);
    return result as T;
  }

  async patch<T>(
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const result = await this.requestGeneric<T>('PATCH', path, body, opts);
    return result as T;
  }

  async delete<T = void>(path: string, opts?: RequestOptions): Promise<T> {
    const result = await this.requestGeneric<T>(
      'DELETE',
      path,
      undefined,
      opts,
    );
    return result as T;
  }

  /**
   * Core generic dispatcher with cache + circuit + status mapping.
   *
   * Uses `circuitBreaker.execute()` only around the transport call so that:
   *  - 5xx and network failures count toward the failure threshold.
   *  - Client-classified responses (401, 404, 422, terminal 4xx) are routed
   *    AROUND the breaker by inspecting `response` *after* `execute()` returns.
   *
   * The trick: `execute()`'s wrapped operation only throws on transport or
   * 5xx errors. Other non-OK statuses are returned to the outer function via
   * a normal `{response}` result so the breaker sees them as success
   * (server is healthy, just responding with a client error).
   */
  private async requestGeneric<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    opts: RequestOptions | undefined,
  ): Promise<T | null> {
    // Cache lookup (GET only, unless bypassed)
    const cacheKey =
      method === 'GET' && !opts?.noCache
        ? this.buildCacheKey(method, path, opts?.authToken)
        : null;
    if (cacheKey) {
      const cached = CrmClientService.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached as T;
      }
    }

    const endpoint = `${method} ${path}`;

    // Pre-check: if circuit is already OPEN, fail fast with a clean exception.
    if (
      CrmClientService.circuitBreaker.getStats().state ===
      CircuitBreakerState.OPEN
    ) {
      contactsClientMetrics.incTerminalFailure('circuit_open');
      throw new ContactsClientUnavailableException({
        correlationId: readCorrelationIdFromCls(),
        endpoint,
        reason: 'circuit_open',
        totalLatencyMs: 0,
      });
    }

    const url = path.startsWith('http')
      ? path
      : `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;

    const requestInit: RequestInit = {
      method,
      headers: this.buildHeaders(opts),
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    // Hardened generic path (EVO-1205): fixed 5s timeout + up to N retries on
    // 5xx/network/429 with an explicit backoff schedule (1s, 2s, 4s). 4xx are
    // not retried. On exhaustion we throw ContactsClientUnavailableException
    // carrying the correlationId + debug context, and emit Prometheus counters.
    const backoff = this.genericBackoffMs;
    const maxRetries = backoff.length;
    const effectiveTimeout = opts?.timeoutMs ?? this.genericTimeout;
    const startedAt = Date.now();

    let lastStatusCode: number | undefined;
    let terminalReason: ContactsClientTerminalReason = 'network';

    // Phase 1: transport + 5xx + retry loop, wrapped in the circuit breaker.
    // Returns the final Response (client-classified or success), or throws
    // a transport/5xx Error that the breaker counts.
    let response: Response;
    try {
      response = await CrmClientService.circuitBreaker.execute<Response>(
        async () => {
          let lastTransportError: Error = new Error('Unknown error');

          // attempt 0 = initial try; attempts 1..maxRetries = retries.
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(
              () => controller.abort(),
              effectiveTimeout,
            );

            let attemptResponse: Response;
            try {
              attemptResponse = await fetch(url, {
                ...requestInit,
                signal: controller.signal,
              });
            } catch (networkErr: any) {
              clearTimeout(timeoutId);
              const isTimeout = networkErr?.name === 'AbortError';
              lastTransportError = networkErr;
              terminalReason = isTimeout ? 'timeout' : 'network';
              if (isTimeout) contactsClientMetrics.incTimeout();
              CrmClientService.logger.error(
                `CRM API ${isTimeout ? 'timeout' : 'network failure'} [Attempt ${
                  attempt + 1
                }] ${JSON.stringify({
                  url,
                  method,
                  error: networkErr?.message ?? String(networkErr),
                  attempt: attempt + 1,
                })}`,
              );
              if (attempt < maxRetries) {
                contactsClientMetrics.incRetry(
                  isTimeout ? 'timeout' : 'network',
                );
                await new Promise((resolve) =>
                  setTimeout(resolve, backoff[attempt]),
                );
                continue;
              }
              throw networkErr;
            }
            clearTimeout(timeoutId);

            // 5xx → retry with backoff; throw final to count as circuit failure.
            if (attemptResponse.status >= 500) {
              lastStatusCode = attemptResponse.status;
              terminalReason = 'server_error';
              lastTransportError = new Error(
                `CRM service error (${attemptResponse.status})`,
              );
              if (attempt < maxRetries) {
                contactsClientMetrics.incRetry('server_error');
                await new Promise((resolve) =>
                  setTimeout(resolve, backoff[attempt]),
                );
                continue;
              }
              throw lastTransportError;
            }

            // 429 → respect Retry-After; if exhausted, treat as transport failure.
            if (attemptResponse.status === 429) {
              lastStatusCode = 429;
              terminalReason = 'rate_limited';
              const retryAfter = attemptResponse.headers.get('Retry-After');
              const retryAfterMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : NaN;
              // Retry-After may be an HTTP-date (NaN here) — fall back to the
              // backoff schedule rather than scheduling an immediate retry.
              const waitTime = Number.isFinite(retryAfterMs)
                ? retryAfterMs
                : backoff[attempt];

              if (attempt < maxRetries) {
                contactsClientMetrics.incRetry('rate_limited');
                CrmClientService.logger.warn(
                  `CRM API rate limited, retrying in ${waitTime}ms ${JSON.stringify(
                    {
                      attempt: attempt + 1,
                      maxRetries,
                      method,
                      path,
                    },
                  )}`,
                );
                await new Promise((resolve) => setTimeout(resolve, waitTime));
                continue;
              }
              throw new Error('CRM rate limit exceeded after retries');
            }

            // Anything else (2xx, 401, 404, 422, other 4xx) → return response to caller.
            return attemptResponse;
          }

          throw lastTransportError;
        },
      );
    } catch {
      // Network / timeout / 5xx / rate-limit-exhausted / circuit OPEN — the CRM
      // is unavailable after the full retry budget. Surface the rich exception.
      contactsClientMetrics.incTerminalFailure(terminalReason);
      throw new ContactsClientUnavailableException({
        correlationId: readCorrelationIdFromCls(),
        endpoint,
        lastStatusCode,
        totalLatencyMs: Date.now() - startedAt,
        reason: terminalReason,
      });
    }

    // Phase 2: interpret the response (server is healthy from the breaker's POV).
    if (response.ok) {
      if (response.status === 204) {
        return null;
      }
      const data = (await response.json()) as T;
      if (cacheKey) {
        CrmClientService.cache.set(cacheKey, data);
      }
      return data;
    }

    if (response.status === 404) {
      if (method === 'GET') {
        return null;
      }
      throw new NotFoundException(
        `CRM resource not found at ${method} ${path}`,
      );
    }

    if (response.status === 401) {
      throw new UnauthorizedException('CRM authentication failed (401)');
    }

    if (response.status === 422) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new BadRequestException(errorBody);
    }

    // Other 4xx — surface as BadRequest (unexpected but client-fault).
    let otherBody: any = null;
    try {
      otherBody = await response.json();
    } catch {
      otherBody = await response.text();
    }
    throw new BadRequestException(
      `CRM request failed (${response.status}): ${
        typeof otherBody === 'string' ? otherBody : JSON.stringify(otherBody)
      }`,
    );
  }

  private buildHeaders(opts?: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'EvoFlow-CrmClient/1.0',
    };

    if (opts?.authToken) {
      headers['Authorization'] = `Bearer ${opts.authToken}`;
    } else {
      // s2s default — keep wire format compatible with existing temporal nodes.
      headers['X-Service-Token'] = this.serviceToken;
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
    const tokenSource = authToken ?? this.serviceToken;
    const tokenHash = createHash('sha256')
      .update(tokenSource)
      .digest('hex')
      .slice(0, 16);
    return createHash('sha256')
      .update(`${method}:${path}:${tokenHash}`)
      .digest('hex');
  }

  // ============================================================================
  // Legacy domain methods (preserved verbatim from EvoAICRMBaseService).
  // These are consumed by temporal nodes in src/modules/temporal/.../evoai/.
  // ============================================================================

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Service-Token': this.serviceToken,
      'User-Agent': 'EvoAI-Campaign-Temporal/1.0',
    };
  }

  private getConversationURL(conversationId: string): string {
    return `${this.baseURL}/api/v1/conversations/${conversationId}`;
  }

  private getInboxURL(inboxId: string): string {
    return `${this.baseURL}/api/v1/inboxes/${inboxId}`;
  }

  private async executeRequest<T>(
    url: string,
    options: RequestInit,
    context: { nodeType: string; conversationId: string },
  ): Promise<CrmApiResponse<T>> {
    const maxRetries = 3;
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.getHeaders(),
            ...options.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('CRM Service token authentication failed');
          }

          if (response.status === 403) {
            throw new Error(
              'CRM Service insufficient permissions for this operation',
            );
          }

          if (response.status === 404) {
            throw new Error('CRM Resource not found (conversation)');
          }

          if (response.status === 422) {
            const errorBody = await response.text();
            throw new Error(`CRM Validation error: ${errorBody}`);
          }

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 5000;

            if (attempt < maxRetries) {
              CrmClientService.logger.warn(
                `CRM API rate limited, retrying in ${waitTime}ms ${JSON.stringify(
                  {
                    attempt,
                    maxRetries,
                    nodeType: context.nodeType,
                  },
                )}`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitTime));
              continue;
            }
          }

          throw new Error(
            `CRM API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const responseData = await response.json();

        return {
          success: true,
          data: responseData,
          statusCode: response.status,
        };
      } catch (error) {
        lastError = error as Error;

        CrmClientService.logger.error(
          `CRM API Request failed [Attempt ${attempt}] ${JSON.stringify({
            url,
            method: options.method || 'GET',
            error: error.message,
            nodeType: context.nodeType,
            conversationId: context.conversationId,
            attempt,
          })}`,
        );

        if (
          error.message.includes('authentication failed') ||
          error.message.includes('insufficient permissions') ||
          error.message.includes('not found') ||
          error.message.includes('Validation error')
        ) {
          break;
        }

        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'CRM API request failed after all retries',
    };
  }

  async validateServiceToken(): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/internal/service_tokens/validate`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'token-validation', conversationId: 'n/a' },
    );
  }

  async getConversation(
    context: CrmConversationContext,
  ): Promise<CrmApiResponse<any>> {
    const url = this.getConversationURL(context.conversationId);
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'get-conversation', conversationId: context.conversationId },
    );
  }

  async assignAgent(
    context: CrmConversationContext,
    agentId: string | null,
    nodeType: string = 'assign-agent',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/assignments`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ assignee_id: agentId }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async assignTeam(
    context: CrmConversationContext,
    teamId: string | null,
    nodeType: string = 'assign-team',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/assignments`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ team_id: teamId }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async createConversation(
    contactId: string,
    inboxId: string,
    message: string,
    sourceId?: string,
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/conversations`;

    const payload = {
      source_id: sourceId || Date.now().toString(),
      inbox_id: inboxId,
      contact_id: contactId,
      status: 'open',
      message: {
        content: message,
      },
    };

    return this.executeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      },
      { nodeType: 'create-conversation', conversationId: 'new' },
    );
  }

  async sendMessage(
    context: CrmConversationContext,
    content: string,
    isPrivate: boolean = false,
    nodeType: string = 'send-message',
    templateParams?: CrmMessageTemplateParams,
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/messages`;
    return this.executeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({
          content,
          private: isPrivate,
          ...(templateParams && { template_params: templateParams }),
        }),
      },
      { nodeType, conversationId: context.conversationId },
    );
  }

  /**
   * Active message templates of an inbox (EVO-1231/EVO-1232 CRUD). The
   * success_response envelope puts the template array under `data.data`.
   */
  async getInboxMessageTemplates(
    inboxId: string,
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/inboxes/${inboxId}/message_templates?active=true&per_page=-1`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'get-message-templates', conversationId: 'n/a' },
    );
  }

  async sendTranscript(
    context: CrmConversationContext,
    email: string,
    nodeType: string = 'send-transcript',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/transcript`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ email }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async muteConversation(
    context: CrmConversationContext,
    nodeType: string = 'mute-conversation',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/mute`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({}) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async changeConversationStatus(
    context: CrmConversationContext,
    status: 'resolved' | 'pending' | 'snoozed' | 'open',
    nodeType: string = 'change-status',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/toggle_status`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ status }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async changeConversationPriority(
    context: CrmConversationContext,
    priority: 'low' | 'medium' | 'high' | 'urgent' | null,
    nodeType: string = 'change-priority',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/toggle_priority`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ priority }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async assignBot(
    inboxId: string,
    botId: string | null,
    nodeType: string = 'assign-bot',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getInboxURL(inboxId)}/set_agent_bot`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ agent_bot_id: botId }) },
      { nodeType, conversationId: 'n/a' },
    );
  }

  async getInboxBot(
    inboxId: string,
    nodeType: string = 'get-inbox-bot',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getInboxURL(inboxId)}/agent_bot`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType, conversationId: 'n/a' },
    );
  }

  async getSystemStatus(): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/internal/system/status`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'system-status', conversationId: 'n/a' },
    );
  }

  async getInboxes(): Promise<CrmApiResponse<any[]>> {
    const url = `${this.baseURL}/api/v1/inboxes`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'get-inboxes', conversationId: 'n/a' },
    );
  }

  async getCannedResponse(
    cannedResponseId: string,
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/canned_responses/${cannedResponseId}`;
    return this.executeRequest(
      url,
      { method: 'GET' },
      { nodeType: 'get-canned-response', conversationId: 'n/a' },
    );
  }

  async addToPipeline(
    pipelineId: string,
    conversationId: string,
    stageId?: string,
    nodeType: string = 'assign-to-pipeline',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/pipelines/${pipelineId}/pipeline_items`;
    const body: Record<string, unknown> = {
      item_id: conversationId,
      type: 'conversation',
    };
    if (stageId) body.pipeline_stage_id = stageId;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify(body) },
      { nodeType, conversationId },
    );
  }

  async moveToPipelineStage(
    pipelineId: string,
    conversationId: string,
    stageId: string,
    nodeType: string = 'move-to-pipeline-stage',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/pipelines/${pipelineId}/pipeline_items/move_conversation`;
    return this.executeRequest(
      url,
      {
        method: 'PATCH',
        body: JSON.stringify({
          conversation_id: conversationId,
          pipeline_stage_id: stageId,
        }),
      },
      { nodeType, conversationId },
    );
  }

  async createPipelineTask(
    conversationId: string,
    task: {
      title: string;
      description?: string;
      task_type?: string;
      priority?: string;
      assigned_to_id?: string;
      due_in?: string;
    },
    nodeType: string = 'create-pipeline-task',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/pipeline_tasks/for_conversation`;
    return this.executeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ conversation_id: conversationId, ...task }),
      },
      { nodeType, conversationId },
    );
  }

  async sendEmailTeam(
    context: CrmConversationContext,
    teamIds: string[],
    message: string,
    nodeType: string = 'send-email-team',
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.getConversationURL(context.conversationId)}/email_team`;
    return this.executeRequest(
      url,
      { method: 'POST', body: JSON.stringify({ team_ids: teamIds, message }) },
      { nodeType, conversationId: context.conversationId },
    );
  }

  async createScheduledAction(
    contactId: string,
    actionType: string,
    scheduledFor: Date,
    payload: Record<string, any>,
    options?: {
      journeySessionId?: string;
      notifyUserId?: string;
      maxRetries?: number;
      conversationId?: string;
      dealId?: string;
      templateId?: string;
    },
  ): Promise<CrmApiResponse<any>> {
    const url = `${this.baseURL}/api/v1/scheduled_actions`;

    const scheduledActionPayload: Record<string, any> = {
      contact_id: contactId,
      action_type: actionType,
      scheduled_for: scheduledFor.toISOString(),
      payload: payload,
    };

    if (options?.journeySessionId) {
      scheduledActionPayload.journey_session_id = options.journeySessionId;
    }

    if (options?.notifyUserId) {
      scheduledActionPayload.notify_user_id = options.notifyUserId;
    }

    if (options?.maxRetries !== undefined) {
      scheduledActionPayload.max_retries = options.maxRetries;
    }

    if (options?.conversationId) {
      scheduledActionPayload.conversation_id = options.conversationId;
    }

    if (options?.dealId) {
      scheduledActionPayload.deal_id = options.dealId;
    }

    if (options?.templateId) {
      scheduledActionPayload.template_id = options.templateId;
    }

    return this.executeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ scheduled_action: scheduledActionPayload }),
      },
      {
        nodeType: 'create-scheduled-action',
        conversationId: options?.conversationId || 'n/a',
      },
    );
  }

  // ============================================================================
  // Test/diagnostic helpers
  // ============================================================================

  /**
   * Manually reset the shared circuit breaker (test-only).
   */
  static resetCircuitBreakerForTests(): void {
    CrmClientService.circuitBreaker.reset();
  }

  /**
   * Clear the shared cache (test-only).
   */
  static clearCacheForTests(): void {
    CrmClientService.cache.clear();
  }
}
