import { EvoExtensionPoints, RuntimeContext } from '../registry';
import { RuntimeContextMiddleware } from './runtime-context.middleware';
import { RUNTIME_CONTEXT_REQUEST_KEY } from './runtime-context.types';

type MockReq = {
  user?: { id: string };
  header: (name: string) => string | undefined;
} & Record<string, unknown>;

function buildReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    user: undefined,
    header: () => undefined,
    ...overrides,
  };
}

describe('RuntimeContextMiddleware', () => {
  let middleware: RuntimeContextMiddleware;

  beforeEach(() => {
    middleware = new RuntimeContextMiddleware();
    EvoExtensionPoints.reset();
  });

  it('populates default context with request_id and null user_id for unauthenticated requests', async () => {
    const req = buildReq();
    const next = jest.fn();

    await middleware.use(req as never, {} as never, next);

    const ctx = req[RUNTIME_CONTEXT_REQUEST_KEY] as RuntimeContext;
    expect(ctx.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.user_id).toBeNull();
    expect(ctx.scope_id).toBeNull();
    expect(ctx.feature_flags).toEqual({});
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses x-request-id header when provided', async () => {
    const req = buildReq({
      header: (name: string) =>
        name === 'x-request-id' ? 'req-from-upstream-123' : undefined,
    });

    await middleware.use(req as never, {} as never, jest.fn());

    expect(
      (req[RUNTIME_CONTEXT_REQUEST_KEY] as RuntimeContext).request_id,
    ).toBe('req-from-upstream-123');
  });

  it('populates user_id when request has authenticated user', async () => {
    const req = buildReq({ user: { id: 'user-42' } });

    await middleware.use(req as never, {} as never, jest.fn());

    expect((req[RUNTIME_CONTEXT_REQUEST_KEY] as RuntimeContext).user_id).toBe(
      'user-42',
    );
  });

  it('forwards default context to the registered enricher and stores the result', async () => {
    const req = buildReq({ user: { id: 'user-1' } });
    EvoExtensionPoints.replace('runtime_context', (_r, defaultCtx) => ({
      ...defaultCtx,
      scope_id: 'scope-A',
      feature_flags: { beta: true },
    }));

    await middleware.use(req as never, {} as never, jest.fn());

    const ctx = req[RUNTIME_CONTEXT_REQUEST_KEY] as RuntimeContext;
    expect(ctx.scope_id).toBe('scope-A');
    expect(ctx.feature_flags).toEqual({ beta: true });
    expect(ctx.user_id).toBe('user-1');
  });
});
