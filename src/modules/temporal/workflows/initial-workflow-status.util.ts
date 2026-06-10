export type WorkflowExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused';

/**
 * Maps a persisted journey-session status into the workflow loop's vocabulary
 * (EVO-1690). The session store speaks 'active'/'waiting'/'completed'; the
 * execution loop only advances on 'running' — copying the session status
 * verbatim made `while (state.status === 'running')` false on the first
 * iteration and every pre-created session (the norm since EVO-1644) completed
 * with zero nodes executed. Only 'paused' survives the mapping: a paused
 * session must not resume by itself.
 */
export function resolveInitialWorkflowStatus(
  sessionStatus: string | undefined,
): WorkflowExecutionStatus {
  return sessionStatus === 'paused' ? 'paused' : 'running';
}
