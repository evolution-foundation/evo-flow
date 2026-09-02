import { SetVariableNode, SetVariableNodeInput } from './set-variable.node';

// EVO-1840: lock the increase/decrease arithmetic, and — just as important —
// that every way it cannot be honored surfaces as a visible failure instead of
// quietly writing a wrong number.
describe('SetVariableNode', () => {
  let node: SetVariableNode;

  const input = (
    nodeData: SetVariableNodeInput['nodeData'],
  ): SetVariableNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    nodeData,
  });

  beforeEach(() => {
    node = new SetVariableNode();
    // logNodeError calls the @temporalio/activity logger, which needs an activity
    // context; stub it out for unit tests.
    jest.spyOn(node as any, 'logNodeError').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function stubSession(vars: Record<string, any>) {
    jest
      .spyOn(node as any, 'loadSessionVariables')
      .mockResolvedValue(vars);
  }

  describe('arithmetic', () => {
    it('increase adds the amount to the current numeric value', async () => {
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(result.success).toBe(true);
      expect(result.variables?.lead_score).toBe(50);
    });

    it('increase from an unset variable starts at 0 (lands on the delta)', async () => {
      stubSession({});
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(result.variables?.lead_score).toBe(40);
    });

    it('increase from a null/empty prior value starts at 0', async () => {
      stubSession({ lead_score: null, other: '' });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(result.variables?.lead_score).toBe(40);
    });

    it('decrease subtracts the amount', async () => {
      stubSession({ lead_score: 100 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'decrease', value: '30' }),
      );
      expect(result.variables?.lead_score).toBe(70);
    });

    it('accumulates across runs (0 -> +40 -> 40 -> +30 -> 70)', async () => {
      stubSession({});
      const first = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(first.variables?.lead_score).toBe(40);

      // second run sees the persisted value
      stubSession({ lead_score: first.variables?.lead_score });
      const second = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '30' }),
      );
      expect(second.variables?.lead_score).toBe(70);
    });

    it('resolves a {{variable}} amount against the session before parsing', async () => {
      stubSession({ lead_score: 10, bonus: 5 });
      const result = await node.execute(
        input({
          variableName: 'lead_score',
          operation: 'increase',
          value: '{{bonus}}',
        }),
      );
      expect(result.success).toBe(true);
      expect(result.variables?.lead_score).toBe(15);
    });
  });

  describe('plain SET is untouched', () => {
    it('plain SET is unchanged and does not read the session', async () => {
      const loadSpy = jest
        .spyOn(node as any, 'loadSessionVariables')
        .mockResolvedValue({});
      const result = await node.execute(
        input({ variableName: 'greeting', operation: 'set', value: 'hello' }),
      );
      expect(result.variables?.greeting).toBe('hello');
      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('SET is the default when no operation is given', async () => {
      const result = await node.execute(
        input({ variableName: 'greeting', value: 'hi' }),
      );
      expect(result.variables?.greeting).toBe('hi');
    });
  });

  describe('multiple variables', () => {
    it('honors increase on the array input shape too', async () => {
      stubSession({ lead_score: 10, visits: 2 });
      const result = await node.execute(
        input({
          operation: 'increase',
          variables: [
            { name: 'lead_score', value: 40 },
            { name: 'visits', value: 1 },
          ],
        }),
      );
      expect(result.success).toBe(true);
      expect(result.variables?.lead_score).toBe(50);
      expect(result.variables?.visits).toBe(3);
    });

    it('plain SET on the array shape is unchanged', async () => {
      const result = await node.execute(
        input({ variables: [{ name: 'greeting', value: 'hello' }] }),
      );
      expect(result.variables?.greeting).toBe('hello');
    });
  });

  describe('visible failure instead of a silent wrong write', () => {
    it('a non-numeric amount fails visibly', async () => {
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: 'abc' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('numeric amount');
    });

    it('an empty amount fails instead of incrementing by 0', async () => {
      // Number('') === 0, which would read as a valid amount
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '' }),
      );
      expect(result.success).toBe(false);
    });

    it('a null amount fails instead of incrementing by 0', async () => {
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: null }),
      );
      expect(result.success).toBe(false);
    });

    it('an unresolvable {{variable}} amount fails visibly', async () => {
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({
          variableName: 'lead_score',
          operation: 'increase',
          value: '{{missing}}',
        }),
      );
      expect(result.success).toBe(false);
    });

    it('a non-numeric CURRENT value fails instead of being clobbered to the delta', async () => {
      stubSession({ lead_score: 'not-a-number' });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not numeric');
      expect(result.variables?.lead_score).toBeUndefined();
    });

    it('a failed session read fails instead of silently rebasing the counter to 0', async () => {
      // degrading to {} here would turn lead_score 500 into 40
      jest
        .spyOn(node as any, 'readSessionVariables')
        .mockRejectedValue(new Error('connection refused'));
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: '40' }),
      );
      expect(result.success).toBe(false);
      expect(result.variables?.lead_score).toBeUndefined();
    });

    it('reports the failure duration, not an epoch timestamp', async () => {
      stubSession({ lead_score: 10 });
      const result = await node.execute(
        input({ variableName: 'lead_score', operation: 'increase', value: 'abc' }),
      );
      expect(result.success).toBe(false);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.executionTime).toBeLessThan(60_000);
    });
  });
});
