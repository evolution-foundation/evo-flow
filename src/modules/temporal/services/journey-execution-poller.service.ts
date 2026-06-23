import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { AppFactory } from '../../../app-factory';
import { getProcessingConfig } from '../../processing/config/processing.config';
import { PrometheusMetrics } from '../../processing/metrics/prometheus-metrics';
import { TEMPORAL_TASK_QUEUES } from '../temporal-task-queues.constants';

const TaskQueueType = temporal.api.enums.v1.TaskQueueType;

/**
 * Snapshot of `journey-execution` queue health (EVO-1764).
 *
 * `healthy` is `false` ONLY on a *confirmed* sustained-zero (a successful poll
 * that has shown zero WORKFLOW pollers for longer than the configured
 * threshold). `stale` is `true` when the last poll failed (Temporal
 * unreachable) — in that case the verdict is unknown and callers must NOT treat
 * it as "no worker" (a Temporal outage is a different condition, EVO-1758).
 */
export interface TaskQueuePollerStatus {
  workflowPollers: number;
  activityPollers: number;
  zeroSince: Date | null;
  sustainedZeroMs: number;
  healthy: boolean;
  stale: boolean;
}

/**
 * Single source of truth for `journey-execution` executor health (EVO-1764).
 *
 * Periodically calls Temporal `describeTaskQueue` (WORKFLOW + ACTIVITY poller
 * types) and maintains a "zero-since" timestamp for the WORKFLOW poller count —
 * the authoritative "is there an executor" signal, since a workflow needs a
 * WORKFLOW poller to run even its first line. Both the readiness indicator and
 * the dispatch fail-fast guard read this one service so they always agree, and
 * the *sustained* (not instantaneous) semantics live in one place so a benign
 * Temporal restart — from which the worker auto-recovers (EVO-1758) — never
 * flaps the signal.
 *
 * Owns its own lightweight `Connection` (mirrors the per-service pattern already
 * used by the trigger processor) so it does not drag in the heavy TemporalModule
 * graph; this service lives in the dependency-light TemporalQueueHealthModule.
 */
@Injectable()
export class JourneyExecutionPollerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(
    JourneyExecutionPollerService.name,
  );
  private readonly taskQueue = TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION;

  private connection: Connection | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** True while the background interval is running (journey-worker modes). */
  private monitoring = false;
  /** Shared in-flight poll so the interval and on-demand callers never run two
   * concurrent polls on the same connection (a catch-path close would race a
   * live RPC). */
  private inFlightPoll: Promise<void> | null = null;

  private workflowPollers = 0;
  private activityPollers = 0;
  /** Epoch ms since which WORKFLOW pollers have been zero; null when healthy. */
  private zeroSinceMs: number | null = null;
  /** Last poll error message; null after a successful poll (verdict known). */
  private lastError: string | null = null;

  constructor(private readonly metrics: PrometheusMetrics) {}

  async onModuleInit(): Promise<void> {
    // Only the journey worker modes have an executor to watch.
    if (!AppFactory.shouldStartJourneyWorker()) {
      return;
    }

    // Prime state once at boot so /ready and /metrics reflect reality before the
    // first interval tick, then poll on a tunable interval.
    await this.poll();
    this.timer = setInterval(
      () => void this.poll(),
      getProcessingConfig().temporal!.queuePollIntervalMs,
    );
    // Polling must never keep a draining process alive.
    this.timer.unref?.();
    this.monitoring = true;

    this.logger.log(
      `Journey-execution queue-health poller started (every ${
        getProcessingConfig().temporal!.queuePollIntervalMs
      }ms)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.monitoring = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.closeConnection();
  }

  /**
   * Cached, synchronous snapshot — safe for the readiness probe (no I/O, so it
   * cannot hang the probe). Reflects the last successful/failed poll.
   */
  getStatus(): TaskQueuePollerStatus {
    const stale = this.lastError !== null;
    const sustainedZeroMs = this.zeroSinceMs
      ? Date.now() - this.zeroSinceMs
      : 0;
    const threshold = getProcessingConfig().temporal!.zeroPollerSustainedMs;
    // Stale → unknown → do not report unhealthy (a Temporal outage is not the
    // same as "no worker"; see EVO-1758).
    const healthy = stale
      ? true
      : !(this.workflowPollers === 0 && sustainedZeroMs >= threshold);
    return {
      workflowPollers: this.workflowPollers,
      activityPollers: this.activityPollers,
      zeroSince: this.zeroSinceMs ? new Date(this.zeroSinceMs) : null,
      sustainedZeroMs,
      healthy,
      stale,
    };
  }

  /**
   * Live re-poll then return the fresh snapshot. Used by the dispatch guard so
   * its terminate/fail decision is based on the current queue state, not on a
   * snapshot up to one poll-interval stale (closes the start→verdict race).
   */
  async refreshNow(): Promise<TaskQueuePollerStatus> {
    await this.poll();
    return this.getStatus();
  }

  /**
   * "Should the dispatch guard fail this journey" decision (EVO-1764). Never
   * true while stale (Temporal unreachable) so an outage does not start failing
   * journeys.
   *
   * Two modes:
   * - **Hot automated path** (default, the Kafka trigger): trust the background
   *   poller's cached snapshot and only pay a fresh confirmatory poll when it
   *   already suspects zero pollers — so a healthy dispatch costs zero RPC. If
   *   the background poller is not running in this mode at all, there is no
   *   detection regime, so the guard is a no-op (no per-dispatch RPC). Gated on
   *   the *sustained* window to tolerate transient blips.
   * - **`forceLive`** (the manual `startJourney` endpoint, low frequency): always
   *   do a fresh poll and treat a confirmed live zero-poller as unexecutable
   *   without the sustained window — a deliberate user action prefers an
   *   immediate, retryable error over a phantom session, and the process running
   *   the endpoint may not run the background poller at all.
   */
  async isQueueUnexecutable(
    opts: { forceLive?: boolean } = {},
  ): Promise<{ unexecutable: boolean; status: TaskQueuePollerStatus }> {
    if (opts.forceLive) {
      const status = await this.refreshNow();
      return {
        unexecutable: !status.stale && status.workflowPollers === 0,
        status,
      };
    }

    // Hot path: no background monitoring → no guard, no RPC.
    if (!this.monitoring) {
      return { unexecutable: false, status: this.getStatus() };
    }
    // Trust the cached snapshot; pollers present or unknown(stale) → executable
    // with no extra RPC.
    const cached = this.getStatus();
    if (cached.stale || cached.workflowPollers > 0) {
      return { unexecutable: false, status: cached };
    }
    // Background poller already sees zero — confirm live (closes the
    // start→verdict race) and require the sustained window.
    const status = await this.refreshNow();
    const graceMs = getProcessingConfig().temporal!.dispatchGraceMs;
    const unexecutable =
      !status.stale &&
      status.workflowPollers === 0 &&
      status.sustainedZeroMs >= graceMs;
    return { unexecutable, status };
  }

  /**
   * One poll cycle, de-duplicated: if a poll is already in flight (interval tick
   * or an on-demand refresh), concurrent callers await that same poll instead of
   * starting a second one on the shared connection (which a catch-path close
   * could race). Never throws — failures freeze the verdict as `stale`.
   */
  private poll(): Promise<void> {
    if (this.inFlightPoll) return this.inFlightPoll;
    this.inFlightPoll = this.doPoll().finally(() => {
      this.inFlightPoll = null;
    });
    return this.inFlightPoll;
  }

  private async doPoll(): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const namespace = getProcessingConfig().temporal!.namespace || 'default';

      const [workflow, activity] = await Promise.all([
        connection.workflowService.describeTaskQueue({
          namespace,
          taskQueue: { name: this.taskQueue },
          taskQueueType: TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,
        }),
        connection.workflowService.describeTaskQueue({
          namespace,
          taskQueue: { name: this.taskQueue },
          taskQueueType: TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
        }),
      ]);

      this.workflowPollers = workflow.pollers?.length ?? 0;
      this.activityPollers = activity.pollers?.length ?? 0;
      this.lastError = null;

      const now = Date.now();
      if (this.workflowPollers === 0) {
        // Start (or keep) the sustained-zero clock.
        if (this.zeroSinceMs === null) this.zeroSinceMs = now;
      } else {
        // An executor is present — reset the clock.
        this.zeroSinceMs = null;
      }

      this.metrics.setTemporalTaskQueueMetrics(
        this.taskQueue,
        this.workflowPollers,
        this.activityPollers,
        this.zeroSinceMs ? (now - this.zeroSinceMs) / 1000 : 0,
      );
    } catch (err) {
      // Connection/RPC failure: hold the prior verdict, mark stale, and drop the
      // connection so the next poll reconnects. Do NOT advance the zero clock —
      // "Temporal unreachable" must not be read as "no worker" (EVO-1764 F7).
      this.lastError = (err as Error).message;
      this.logger.warn(
        `journey-execution queue poll failed (held as stale): ${this.lastError}`,
      );
      await this.closeConnection();
    }
  }

  private async ensureConnection(): Promise<Connection> {
    if (!this.connection) {
      this.connection = await Connection.connect({
        address: getProcessingConfig().temporal!.serverAddress,
      });
    }
    return this.connection;
  }

  private async closeConnection(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      await conn.close().catch(() => undefined);
    }
  }
}
