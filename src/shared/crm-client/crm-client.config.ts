/**
 * CRM client configuration (env-driven).
 *
 * Reads env vars directly (no ConfigService dependency) so that
 * `new CrmClientService()` works for legacy consumers (temporal nodes that
 * instantiate the service via `new ...()` rather than DI).
 */

export interface CrmClientConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  retryMaxAttempts: number;
  cacheTtlMs: number;
  circuitThreshold: number;
  circuitRecoveryMs: number;
  /**
   * Per-request timeout (ms) for the generic client path (get/post/patch/
   * delete used by the contacts/labels/custom-attributes consumers). Kept
   * separate from `timeoutMs` so the legacy temporal-node path can keep its
   * generous 30s budget while the hardened generic path enforces the PRD's 5s
   * (NFR31). Overridable per call via `RequestOptions.timeoutMs`.
   */
  genericTimeoutMs: number;
  /**
   * Backoff schedule (ms) between retries on the generic path. Length defines
   * the retry count: `[1000, 2000, 4000]` means up to 3 retries (4 attempts
   * total) on 5xx/network errors, matching the PRD (FR35, NFR31).
   */
  genericRetryBackoffMs: number[];
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBackoffSchedule = (
  value: string | undefined,
  fallback: number[],
): number[] => {
  if (!value) return fallback;
  const parsed = value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : fallback;
};

export const getCrmClientConfig = (): CrmClientConfig => ({
  baseUrl: process.env.EVOAI_CRM_BASE_URL || 'http://localhost:3000',
  apiToken: process.env.EVOAI_CRM_API_TOKEN || '',
  timeoutMs: parseInteger(process.env.EVOAI_CRM_TIMEOUT_MS, 30_000),
  retryMaxAttempts: parseInteger(process.env.EVOAI_CRM_RETRY_MAX_ATTEMPTS, 3),
  cacheTtlMs: parseInteger(process.env.EVOAI_CRM_CACHE_TTL_MS, 30_000),
  circuitThreshold: parseInteger(process.env.EVOAI_CRM_CIRCUIT_THRESHOLD, 5),
  circuitRecoveryMs: parseInteger(
    process.env.EVOAI_CRM_CIRCUIT_RECOVERY_MS,
    60_000,
  ),
  genericTimeoutMs: parseInteger(
    process.env.EVOAI_CRM_CLIENT_TIMEOUT_MS,
    5_000,
  ),
  genericRetryBackoffMs: parseBackoffSchedule(
    process.env.EVOAI_CRM_CLIENT_RETRY_BACKOFF_MS,
    [1_000, 2_000, 4_000],
  ),
});
