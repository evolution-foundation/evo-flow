/**
 * AuthClient configuration (env-driven).
 *
 * Points to evo-auth-service-community. Reuses
 * `AUTH_APIKEY_INTEGRATION_LOCAL` as the service-to-service token if a
 * dedicated `EVO_AUTH_API_TOKEN` is not provided.
 */

export interface AuthClientConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  cacheTtlMs: number;
  circuitThreshold: number;
  circuitRecoveryMs: number;
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getAuthClientConfig = (): AuthClientConfig => ({
  baseUrl: process.env.EVO_AUTH_SERVICE_URL || 'http://localhost:3001',
  apiToken:
    process.env.EVO_AUTH_API_TOKEN ||
    process.env.AUTH_APIKEY_INTEGRATION_LOCAL ||
    '',
  timeoutMs: parseInteger(process.env.EVO_AUTH_TIMEOUT_MS, 10_000),
  cacheTtlMs: parseInteger(process.env.EVO_AUTH_CACHE_TTL_MS, 30_000),
  circuitThreshold: parseInteger(process.env.EVOAI_CRM_CIRCUIT_THRESHOLD, 5),
  circuitRecoveryMs: parseInteger(
    process.env.EVOAI_CRM_CIRCUIT_RECOVERY_MS,
    60_000,
  ),
});
