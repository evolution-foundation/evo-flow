import { resolveInitialWorkflowStatus } from './initial-workflow-status.util';

describe('resolveInitialWorkflowStatus (EVO-1690 regression)', () => {
  it("maps the session-store 'active' status into the loop's 'running'", () => {
    expect(resolveInitialWorkflowStatus('active')).toBe('running');
  });

  it("maps 'waiting' into 'running' so signal-driven resumes re-enter the loop", () => {
    expect(resolveInitialWorkflowStatus('waiting')).toBe('running');
  });

  it("restarts a 'completed' session as 'running' (pre-existing resume semantics)", () => {
    expect(resolveInitialWorkflowStatus('completed')).toBe('running');
  });

  it("defaults to 'running' when the session has no status", () => {
    expect(resolveInitialWorkflowStatus(undefined)).toBe('running');
  });

  it("preserves 'paused' — a paused session must not resume by itself", () => {
    expect(resolveInitialWorkflowStatus('paused')).toBe('paused');
  });
});
