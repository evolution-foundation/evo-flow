/**
 * Generic wrapper returned by most CRM Rails endpoints.
 *
 * The CRM sometimes returns `{ data: ..., message: ... }` and sometimes the
 * raw resource directly. Consumers should handle both shapes (the client
 * passes through whatever the server returns).
 */
export interface ApiResponse<T> {
  data: T;
  message?: string;
}

/**
 * Per-request options for HTTP calls made via CrmClientService.
 */
export interface RequestOptions {
  /**
   * User Bearer token. When provided, sent as `Authorization: Bearer <token>`.
   * When omitted, the client falls back to the service-to-service default
   * header (`X-Service-Token: <EVOAI_CRM_API_TOKEN>`).
   */
  authToken?: string;

  /**
   * Bypass the LRU cache for this call. Only meaningful on GET.
   */
  noCache?: boolean;

  /**
   * Override the default timeout (ms) for this call.
   */
  timeoutMs?: number;

  /**
   * Override the transactionId injected as `X-Request-Id`.
   * If omitted, the client reads `transactionId` from CLS context.
   */
  transactionId?: string;
}
