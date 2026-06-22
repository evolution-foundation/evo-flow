import { SegmentJobService } from './segment-job.service';

// nodeReferencesEvent is a pure predicate over its arguments (no `this` deps),
// so we can exercise it without wiring the injected repositories (EVO-1839 AC6).
describe('SegmentJobService.nodeReferencesEvent — CustomAttribute (EVO-1839)', () => {
  // configService.get is read in the constructor; return the requested default.
  const configService = { get: (_key: string, def?: unknown) => def } as any;
  const svc = new SegmentJobService(
    null as any,
    null as any,
    configService,
  ) as any;

  it('flags a CustomAttribute node on the canonical dotted event', () => {
    expect(
      svc.nodeReferencesEvent(
        { type: 'CustomAttribute' },
        'contact.custom_attribute.changed',
      ),
    ).toBe(true);
  });

  it('flags a CustomAttribute node on the legacy underscore event', () => {
    expect(
      svc.nodeReferencesEvent(
        { type: 'CustomAttribute' },
        'custom_attribute_changed',
      ),
    ).toBe(true);
  });

  it('does not flag a CustomAttribute node on an unrelated event', () => {
    expect(
      svc.nodeReferencesEvent({ type: 'CustomAttribute' }, 'contact.created'),
    ).toBe(false);
  });

  it('still honors Performed nodes (regression)', () => {
    expect(svc.nodeReferencesEvent({ type: 'Performed', event: 'x' }, 'x')).toBe(
      true,
    );
    expect(svc.nodeReferencesEvent({ type: 'Performed', event: 'x' }, 'y')).toBe(
      false,
    );
  });
});
