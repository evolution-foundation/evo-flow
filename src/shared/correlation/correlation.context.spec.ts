import { CorrelationContext } from './correlation.context';

function makeFakeCls() {
  const store = new Map<string, any>();
  let active = false;
  return {
    isActive: () => active,
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => store.set(k, v),
    run: <T>(cb: () => T): T => {
      const prev = active;
      active = true;
      try {
        return cb();
      } finally {
        active = prev;
      }
    },
    activate() {
      active = true;
    },
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('CorrelationContext', () => {
  it('returns undefined when there is no active context', () => {
    const ctx = new CorrelationContext(makeFakeCls() as any);
    expect(ctx.getCorrelationId()).toBeUndefined();
  });

  it('stores and reads the correlation id within an active context (AC3)', () => {
    const cls = makeFakeCls();
    cls.activate();
    const ctx = new CorrelationContext(cls as any);

    ctx.setCorrelationId('abc-123');

    expect(ctx.getCorrelationId()).toBe('abc-123');
  });

  it('runWithCorrelationId exposes the id to the callback and returns its value', () => {
    const ctx = new CorrelationContext(makeFakeCls() as any);

    const result = ctx.runWithCorrelationId('cid-9', () =>
      ctx.getCorrelationId(),
    );

    expect(result).toBe('cid-9');
  });

  describe('resolveIncoming', () => {
    it('generates a UUID v4 when no header is present (AC1)', () => {
      const ctx = new CorrelationContext(makeFakeCls() as any);
      expect(ctx.resolveIncoming(undefined)).toMatch(UUID_RE);
    });

    it('preserves a valid inbound id (AC2)', () => {
      const ctx = new CorrelationContext(makeFakeCls() as any);
      expect(ctx.resolveIncoming('abc-123')).toBe('abc-123');
    });

    it('uses the first value when the header arrives as an array', () => {
      const ctx = new CorrelationContext(makeFakeCls() as any);
      expect(ctx.resolveIncoming(['abc-123', 'second'])).toBe('abc-123');
    });

    it('rejects unsafe inbound values (CRLF / control chars / oversized) and mints a fresh id', () => {
      const ctx = new CorrelationContext(makeFakeCls() as any);
      expect(ctx.resolveIncoming('abc\r\nSet-Cookie: x')).toMatch(UUID_RE);
      expect(ctx.resolveIncoming('a'.repeat(200))).toMatch(UUID_RE);
      expect(ctx.resolveIncoming('has space')).toMatch(UUID_RE);
    });
  });
});
