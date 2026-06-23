/**
 * Canonical Temporal task-queue names (EVO-1764).
 *
 * These strings must match the `taskQueue` configured on the Worker
 * (`Worker.create`) and every `client.workflow.start()` that routes to it.
 * They were previously duplicated as bare `'journey-execution'` literals across
 * the worker, the trigger processor, session helpers and config; centralizing
 * them here keeps the queue-health poller (EVO-1764), the worker and the
 * dispatch path provably in agreement on the same queue name.
 *
 * Only `journey-execution` is centralized here (the queue this card touches);
 * the campaign queue's literals are left untouched to keep the diff scoped.
 */
export const TEMPORAL_TASK_QUEUES = {
  JOURNEY_EXECUTION: 'journey-execution',
} as const;

export type TemporalTaskQueue =
  (typeof TEMPORAL_TASK_QUEUES)[keyof typeof TEMPORAL_TASK_QUEUES];
