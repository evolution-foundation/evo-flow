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
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
});
