import { Counter, register } from 'prom-client';

/**
 * Prometheus counters for the hardened generic CRM client path (NFR31).
 *
 * Exposed as a module-level singleton (not a Nest provider) because
 * `CrmClientService` is instantiated both via DI and via `new ...()` from
 * legacy temporal nodes — a plain singleton works in both. Counters live on
 * the default `register`, which the `/metrics` endpoint scrapes.
 *
 * `getOrCreateCounter` guards against duplicate registration on hot reload /
 * repeated imports (same pattern as `broker-metrics.ts`).
 */

const RETRY_METRIC = 'contacts_client_retry_total';
const TIMEOUT_METRIC = 'contacts_client_timeout_total';
const TERMINAL_FAILURE_METRIC = 'contacts_client_terminal_failure_total';

const getOrCreateCounter = (
  name: string,
  help: string,
  labelNames: string[],
): Counter<string> => {
  const existing = register.getSingleMetric(name) as
    | Counter<string>
    | undefined;
  return existing ?? new Counter({ name, help, labelNames });
};

const retryTotal = getOrCreateCounter(
  RETRY_METRIC,
  'Total retries performed by the generic CRM client on 5xx/network/429 errors.',
  ['reason'],
);

const timeoutTotal = getOrCreateCounter(
  TIMEOUT_METRIC,
  'Total request attempts aborted by the generic CRM client timeout (5s).',
  [],
);

const terminalFailureTotal = getOrCreateCounter(
  TERMINAL_FAILURE_METRIC,
  'Total generic CRM client requests that exhausted retries (or hit an open circuit) and threw ContactsClientUnavailableException.',
  ['reason'],
);

export type ContactsClientRetryReason =
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'rate_limited';

export type ContactsClientTerminalReason =
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'circuit_open';

export const contactsClientMetrics = {
  incRetry(reason: ContactsClientRetryReason): void {
    retryTotal.inc({ reason });
  },
  incTimeout(): void {
    timeoutTotal.inc();
  },
  incTerminalFailure(reason: ContactsClientTerminalReason): void {
    terminalFailureTotal.inc({ reason });
  },
};
