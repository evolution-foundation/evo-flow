import { RequestContextMiddleware } from './request-context.middleware';
import { CorrelationContext } from '../shared/correlation/correlation.context';

function makeFakeCls() {
  const store = new Map<string, any>();
  return {
    isActive: () => true,
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => store.set(k, v),
    run: <T>(cb: () => T): T => cb(),
  };
}

function makeReq(correlationHeader?: string) {
  return {
    ip: '1.2.3.4',
    header: (name: string) =>
      name.toLowerCase() === 'x-correlation-id'
        ? correlationHeader
        : name.toLowerCase() === 'user-agent'
          ? 'jest-UA'
          : undefined,
  } as any;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('RequestContextMiddleware — correlationId', () => {
  function setup() {
    const cls = makeFakeCls();
    const correlation = new CorrelationContext(cls as any);
    const middleware = new RequestContextMiddleware(cls as any, correlation);
    return { cls, correlation, middleware };
  }

  it('generates a UUID v4 correlationId when no header is present (AC1)', () => {
    const { middleware, correlation } = setup();
    const next = jest.fn();

    middleware.use(makeReq(undefined), {} as any, next);

    expect(correlation.getCorrelationId()).toMatch(UUID_RE);
    expect(next).toHaveBeenCalled();
  });

  it('preserves an inbound X-Correlation-Id (AC2) and exposes it via getCorrelationId (AC3)', () => {
    const { middleware, correlation } = setup();

    middleware.use(makeReq('abc-123'), {} as any, jest.fn());

    expect(correlation.getCorrelationId()).toBe('abc-123');
  });

  it('still sets the existing transactionId alongside correlationId', () => {
    const { middleware, cls } = setup();

    middleware.use(makeReq('abc-123'), {} as any, jest.fn());

    expect(cls.get('transactionId')).toBeTruthy();
    expect(cls.get('correlationId')).toBe('abc-123');
  });
});
