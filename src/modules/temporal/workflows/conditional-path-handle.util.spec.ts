import { normalizeConditionalPathHandle } from './conditional-path-handle.util';

describe('normalizeConditionalPathHandle (EVO-1922)', () => {
  it('strips a single leading `path-` prefix (legacy conditional edge handle)', () => {
    expect(normalizeConditionalPathHandle('path-abc123')).toBe('abc123');
  });

  it('returns a non-prefixed handle unchanged (new conditional handle)', () => {
    expect(normalizeConditionalPathHandle('abc123')).toBe('abc123');
  });

  it('matches legacy edge handle against the raw node handle', () => {
    // Edge saved before EVO-1902 -> `path-<id>`; node emits raw `<id>`.
    expect(normalizeConditionalPathHandle('path-branch-1')).toBe(
      normalizeConditionalPathHandle('branch-1'),
    );
  });

  it('matches new edge handle against the raw node handle', () => {
    expect(normalizeConditionalPathHandle('branch-1')).toBe(
      normalizeConditionalPathHandle('branch-1'),
    );
  });

  it('leaves `else` (default path handle) untouched', () => {
    expect(normalizeConditionalPathHandle('else')).toBe('else');
  });

  it('does NOT regress Split: `split-variant-<id>` is returned unchanged', () => {
    // Split prefixes both sides with `split-variant-`; it must NOT be stripped.
    const handle = 'split-variant-42';
    expect(normalizeConditionalPathHandle(handle)).toBe(handle);
  });

  it('strips only the first `path-` occurrence, not nested ones', () => {
    expect(normalizeConditionalPathHandle('path-path-x')).toBe('path-x');
  });

  it('does not strip `path` without the trailing hyphen', () => {
    expect(normalizeConditionalPathHandle('pathway-1')).toBe('pathway-1');
  });

  it('coerces non-string handles to an empty string', () => {
    expect(normalizeConditionalPathHandle(undefined)).toBe('');
    expect(normalizeConditionalPathHandle(null)).toBe('');
    expect(normalizeConditionalPathHandle(123 as unknown)).toBe('');
  });
});
