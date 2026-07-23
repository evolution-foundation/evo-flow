import { SetVariableNode, SetVariableNodeInput } from './set-variable.node';

// EVO-1840: the Set Variable node offers Increase/Decrease in the UI but the
// runtime used to ignore `operation` and do a plain SET, so increments never
// accumulated. These lock the arithmetic and the visible-failure on a bad amount.
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

  it('increase from a non-numeric prior value treats the base as 0', async () => {
    stubSession({ lead_score: 'not-a-number' });
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

  it('a non-numeric amount fails visibly instead of a silent no-op', async () => {
    stubSession({ lead_score: 10 });
    const result = await node.execute(
      input({ variableName: 'lead_score', operation: 'increase', value: 'abc' }),
    );
    expect(result.success).toBe(false);
  });
});
