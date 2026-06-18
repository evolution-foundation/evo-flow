import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SkipResponseTransform } from '../common/decorators/skip-response-transform.decorator';
import {
  ACTIVE_INDICATORS,
  HealthIndicator,
  IndicatorResult,
} from './indicators/health-indicator.interface';

/**
 * Liveness + readiness probes for Kubernetes / Cloud Run (EVO-1226 [5.1]).
 *
 * - `GET /health` (liveness): 200 whenever the process is alive — NO dependency
 *   checks, so a failing dependency never triggers a restart loop.
 * - `GET /ready` (readiness): 200 only after every dependency relevant to this
 *   RUN_MODE responds; otherwise 503 with `{ status, failing, checks }` naming
 *   the failing indicator(s).
 *
 * `@Public()` bypasses auth (probes send no token); `@SkipResponseTransform()`
 * keeps the body un-wrapped so the contract is identical across all RUN_MODEs.
 */
@Controller()
@Public()
@SkipResponseTransform()
export class HealthController {
  constructor(
    @Inject(ACTIVE_INDICATORS)
    private readonly indicators: HealthIndicator[],
  ) {}

  @Get('health')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<{
    status: 'up' | 'down';
    checks: Record<string, 'up' | 'down'>;
    failing?: string[];
    details?: Record<string, Pick<IndicatorResult, 'error' | 'detail'>>;
  }> {
    // allSettled — an indicator's check() should never reject (by contract), but
    // if one does we still degrade gracefully to 'down' instead of a 500.
    const settled = await Promise.all(
      this.indicators.map((indicator) =>
        indicator.check().catch(
          (err): IndicatorResult => ({
            name: indicator.name,
            status: 'down',
            error: (err as Error).message,
          }),
        ),
      ),
    );

    const checks: Record<string, 'up' | 'down'> = {};
    const failing: string[] = [];
    const details: Record<
      string,
      Pick<IndicatorResult, 'error' | 'detail'>
    > = {};
    for (const result of settled) {
      checks[result.name] = result.status;
      if (result.status === 'down') {
        failing.push(result.name);
        // Surface the reason (and structured detail, e.g. which broker topic is
        // missing) to speed up rollout debugging — not just the name/status.
        details[result.name] = { error: result.error, detail: result.detail };
      }
    }

    if (failing.length === 0) {
      return { status: 'up', checks };
    }
    res.status(503);
    return { status: 'down', failing, checks, details };
  }
}
