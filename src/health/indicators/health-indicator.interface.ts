/**
 * Health indicator contract (EVO-1226 [5.1]). Each dependency probe implements
 * `HealthIndicator`; the `HealthController` aggregates the active set for the
 * current RUN_MODE into the `/ready` response.
 *
 * Hard rule: `check()` MUST NEVER reject. Every implementation wraps its work
 * in try/catch (and `withTimeout`) and resolves `{ status: 'down', error }` on
 * failure, so the controller can use `Promise.allSettled` safely and a single
 * wedged dependency never turns into a 500.
 */
export type IndicatorStatus = 'up' | 'down';

export interface IndicatorResult {
  /** Stable key surfaced in the readiness payload (e.g. 'postgres'). */
  name: string;
  status: IndicatorStatus;
  /** Present when `status === 'down'`. Short, log-safe reason. */
  error?: string;
  /** Optional structured detail (e.g. `{ missingTopics: [...] }`). */
  detail?: Record<string, unknown>;
}

export interface HealthIndicator {
  /** Stable key used as the `checks`/`failing` identifier. */
  readonly name: string;
  check(): Promise<IndicatorResult>;
}

/** DI token for the mode-resolved list of indicators injected into the controller. */
export const ACTIVE_INDICATORS = Symbol('ACTIVE_INDICATORS');
