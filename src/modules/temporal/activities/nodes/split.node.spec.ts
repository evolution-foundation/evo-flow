import { SplitNode } from './split.node';

describe('SplitNode (EVO-1828)', () => {
  let node: SplitNode;

  const make = (
    variants?: Array<{ id: string; name: string; percentage: number }>,
    contactId = 'contact-1',
  ) => ({
    nodeId: 'split-1',
    contactId,
    sessionId: 'session-1',
    nodeData: { variants },
  });

  beforeEach(() => {
    node = new SplitNode();
    const logger = (node as any).logger;
    for (const m of ['log', 'debug', 'warn', 'error']) {
      jest.spyOn(logger, m).mockImplementation(() => undefined);
    }
  });

  it('returns a nextNodeHandle pointing at the selected variant (was dropped before the fix)', async () => {
    const res = await node.execute(make());
    expect(res.success).toBe(true);
    expect(res.nextNodeHandle).toMatch(/^split-variant-(variant-a|variant-b)$/);
  });

  it('routes every contact to variant A when A is 100%', async () => {
    const variants = [
      { id: 'variant-a', name: 'A', percentage: 100 },
      { id: 'variant-b', name: 'B', percentage: 0 },
    ];
    for (const c of ['c1', 'c2', 'whatever']) {
      const res = await node.execute(make(variants, c));
      expect(res.nextNodeHandle).toBe('split-variant-variant-a');
    }
  });

  it('routes every contact to variant B when B is 100%', async () => {
    const variants = [
      { id: 'variant-a', name: 'A', percentage: 0 },
      { id: 'variant-b', name: 'B', percentage: 100 },
    ];
    const res = await node.execute(make(variants, 'c1'));
    expect(res.nextNodeHandle).toBe('split-variant-variant-b');
  });

  it('selects deterministically per contactId', async () => {
    const a = await node.execute(make(undefined, 'same-contact'));
    const b = await node.execute(make(undefined, 'same-contact'));
    expect(a.nextNodeHandle).toBe(b.nextNodeHandle);
  });
});
