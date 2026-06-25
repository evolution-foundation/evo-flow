import { BaseNode, NodeExecutionResult } from './base.node';

// interpolateNodeData dynamically imports the activities module to read the
// session from cache; stub it so the test drives the session shape directly.
const mockGetSessionFromCache = jest.fn();
jest.mock('../journey-execution.activities', () => ({
  journeyExecutionActivities: {
    getSessionFromCache: (...args: any[]) => mockGetSessionFromCache(...args),
  },
}));

class TestNode extends BaseNode {
  constructor() {
    super('test-node');
  }

  async execute(): Promise<NodeExecutionResult> {
    return { success: true };
  }

  // Expose the protected method under test.
  public interpolate(input: any, nodeData: any): Promise<any> {
    return this.interpolateNodeData(input, nodeData);
  }
}

describe('BaseNode.interpolateNodeData — journeyId fallback (EVO-1885)', () => {
  let node: TestNode;
  let findOne: jest.Mock;

  beforeEach(() => {
    node = new TestNode();
    findOne = jest.fn();
    // initializeDatabase is the only DB seam; stub it so getRepository(Journey)
    // yields our findOne spy and no real connection is opened.
    jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue({ getRepository: () => ({ findOne }) });
    mockGetSessionFromCache.mockReset();
    findOne.mockReset();
  });

  it('AC1: falls back to session.journeyId when input omits journeyId, resolving journey-default variables', async () => {
    mockGetSessionFromCache.mockResolvedValue({
      id: 's1',
      journeyId: 'journey-from-session',
      variables: {},
    });
    findOne.mockResolvedValue({
      variables: [{ name: 'greeting', defaultValue: 'Hi' }],
    });

    const result = await node.interpolate(
      { sessionId: 's1' }, // no journeyId on input
      { message: '{{greeting}}' },
    );

    expect(findOne).toHaveBeenCalledWith({ where: { id: 'journey-from-session' } });
    expect(result.message).toBe('Hi');
  });

  it('AC2: prefers input.journeyId over session.journeyId when both are present', async () => {
    mockGetSessionFromCache.mockResolvedValue({
      id: 's1',
      journeyId: 'journey-from-session',
      variables: {},
    });
    findOne.mockResolvedValue({ variables: [] });

    await node.interpolate(
      { sessionId: 's1', journeyId: 'journey-from-input' },
      { message: '{{greeting}}' },
    );

    expect(findOne).toHaveBeenCalledWith({ where: { id: 'journey-from-input' } });
  });

  // EVO-1917: the dispatch sweep threads input.journeyId to every interpolating
  // executor. This proves that thread is load-bearing: when the cached session
  // carries no journeyId (e.g. a lean cache shape), the explicitly-dispatched
  // input.journeyId is what resolves journey-default {{variables}}.
  it('EVO-1917: resolves journey defaults from input.journeyId when session has none', async () => {
    mockGetSessionFromCache.mockResolvedValue({
      id: 's1',
      // no journeyId on the session — only the dispatched input carries it
      variables: {},
    });
    findOne.mockResolvedValue({
      variables: [{ name: 'greeting', defaultValue: 'Olá' }],
    });

    const result = await node.interpolate(
      { sessionId: 's1', journeyId: 'journey-from-dispatch' },
      { message: '{{greeting}}' },
    );

    expect(findOne).toHaveBeenCalledWith({
      where: { id: 'journey-from-dispatch' },
    });
    expect(result.message).toBe('Olá');
  });

  it('AC3: skips the journey query when no id resolves, leaving journey-default tokens literal', async () => {
    mockGetSessionFromCache.mockResolvedValue({
      id: 's1',
      // no journeyId
      variables: {},
    });

    const result = await node.interpolate(
      { sessionId: 's1' }, // no journeyId either
      { message: '{{greeting}}' },
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(result.message).toBe('{{greeting}}');
  });

  it('still resolves session variables regardless of journeyId (no regression)', async () => {
    mockGetSessionFromCache.mockResolvedValue({
      id: 's1',
      // no journeyId
      variables: { name: 'Ada' },
    });

    const result = await node.interpolate(
      { sessionId: 's1' },
      { message: 'Hello {{name}}' },
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(result.message).toBe('Hello Ada');
  });
});

describe('BaseNode.interpolateNodeData — EVO-1913: surfaces swallowed errors', () => {
  let node: TestNode;

  beforeEach(() => {
    node = new TestNode();
    mockGetSessionFromCache.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs WARN (not silence) when the session is not found, falling back to raw nodeData', async () => {
    // No session in cache and DB findOne resolves null → the !session branch.
    mockGetSessionFromCache.mockResolvedValue(null);
    jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue({ getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) });
    const warnSpy = jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const result = await node.interpolate(
      { sessionId: 's-missing' },
      { message: '{{greeting}}' },
    );

    // Graceful fallback preserved...
    expect(result.message).toBe('{{greeting}}');
    // ...but no longer silent.
    expect(warnSpy).toHaveBeenCalledWith(
      'Session not found for variable interpolation',
      expect.objectContaining({ sessionId: 's-missing' }),
    );
  });

  it('logs ERROR (not silence) when interpolation throws, still returning the raw nodeData', async () => {
    // Force the try-block to throw by making the cache lookup reject.
    mockGetSessionFromCache.mockRejectedValue(new Error('cache boom'));
    const errorSpy = jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);

    const original = { message: '{{greeting}}' };
    const result = await node.interpolate({ sessionId: 's1', nodeId: 'n1' }, original);

    expect(result).toBe(original);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to interpolate variables, using original data',
      expect.objectContaining({ nodeId: 'n1', error: 'cache boom' }),
    );
  });
});
