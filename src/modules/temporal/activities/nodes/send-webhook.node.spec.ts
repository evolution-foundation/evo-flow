import axios from 'axios';
import { SendWebhookNode, SendWebhookNodeInput } from './send-webhook.node';
import { VariableInterpolationUtil } from '../utils/variable-interpolation.util';

jest.mock('axios');
const mockedAxios = axios as unknown as jest.Mock;

/**
 * EVO-1858: the executor must build the request body from the structured rows
 * (bodyStructured + bodyMode) and coerce number/boolean rows to real JSON
 * primitives AFTER interpolation, while keeping the legacy raw `body` path
 * byte-identical for back-compat.
 */
describe('SendWebhookNode — structured body (EVO-1858)', () => {
  let node: SendWebhookNode;

  const baseData = (
    overrides: Partial<SendWebhookNodeInput['nodeData']>,
  ): SendWebhookNodeInput['nodeData'] => ({
    webhookUrl: 'https://example.test/hook',
    method: 'POST',
    ...overrides,
  });

  const inputWith = (
    overrides: Partial<SendWebhookNodeInput['nodeData']>,
  ): SendWebhookNodeInput => ({
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    nodeData: baseData(overrides),
  });

  // The captured axios request config from the most recent call.
  const sentConfig = () => mockedAxios.mock.calls[0][0];

  beforeEach(() => {
    node = new SendWebhookNode();

    // Treat rows as already-interpolated (interpolation is exercised separately
    // in the dedicated coerce-after-interpolation test below).
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);

    // logNodeError hits @temporalio/activity log.error (needs an activity context).
    jest.spyOn(node as any, 'logNodeError').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'warn').mockImplementation(() => undefined);
    jest
      .spyOn((node as any).logger, 'error')
      .mockImplementation(() => undefined);

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { ok: true }, status: 200 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC1: number row → real JS number with application/json', async () => {
    const result = await node.execute(
      inputWith({
        bodyType: 'json',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'age', value: '30', type: 'number' },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(sentConfig().data).toEqual({ age: 30 });
    expect(sentConfig().headers['Content-Type']).toBe('application/json');
  });

  it('AC1b (F1): undefined bodyMode with rows still builds structured (not JSON.parse of stale body)', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        // bodyMode intentionally absent — the normal editor save shape.
        body: '{"age":"30"}', // stale serialized string body
        bodyStructured: [
          { id: '1', key: 'age', value: '30', type: 'number' },
        ],
      }),
    );

    // Real number from the rows, NOT the string "30" that JSON.parse(body) yields.
    expect(sentConfig().data).toEqual({ age: 30 });
  });

  it('AC2: boolean row → real true/false', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'active', value: 'true', type: 'boolean' },
          { id: '2', key: 'archived', value: 'false', type: 'boolean' },
        ],
      }),
    );

    expect(sentConfig().data).toEqual({ active: true, archived: false });
  });

  it('AC3: string rows and unresolved {{token}} stay strings (no NaN)', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'name', value: 'Ana', type: 'string' },
          // number-typed but token unresolved → must fall back to string.
          { id: '2', key: 'x', value: '{{contact.foo}}', type: 'number' },
        ],
      }),
    );

    expect(sentConfig().data).toEqual({ name: 'Ana', x: '{{contact.foo}}' });
  });

  it('AC4: legacy node with no bodyStructured uses JSON.parse(body) unchanged', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        body: '{"k":"v"}',
      }),
    );

    expect(sentConfig().data).toEqual({ k: 'v' });
    expect(sentConfig().headers['Content-Type']).toBe('application/json');
  });

  it('AC4b: explicit bodyMode "raw" ignores lingering structured rows', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        bodyMode: 'raw',
        body: '{"k":"v"}',
        bodyStructured: [
          { id: '1', key: 'age', value: '30', type: 'number' },
        ],
      }),
    );

    // Raw path wins → string-typed value from the body, rows ignored.
    expect(sentConfig().data).toEqual({ k: 'v' });
  });

  it('AC5: structured form → key=value& with no encoding, no coercion', async () => {
    await node.execute(
      inputWith({
        bodyType: 'form',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'a', value: '1', type: 'string' },
          { id: '2', key: 'b', value: '{{x}}', type: 'string' },
        ],
      }),
    );

    expect(sentConfig().data).toBe('a=1&b={{x}}');
    expect(sentConfig().headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('AC6: blank-key rows are skipped', async () => {
    await node.execute(
      inputWith({
        bodyType: 'json',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'keep', value: '1', type: 'number' },
          { id: '2', key: '   ', value: 'dropme', type: 'string' },
          { id: '3', key: '', value: 'alsodrop', type: 'string' },
        ],
      }),
    );

    expect(sentConfig().data).toEqual({ keep: 1 });
  });

  it('AC7: GET attaches no body even with structured rows', async () => {
    await node.execute(
      inputWith({
        method: 'GET',
        bodyType: 'json',
        bodyMode: 'structured',
        bodyStructured: [
          { id: '1', key: 'age', value: '30', type: 'number' },
        ],
      }),
    );

    expect(sentConfig().data).toBeUndefined();
  });

  // F7: prove coercion runs AFTER real interpolation — the headline guarantee.
  // Drives the real VariableInterpolationUtil over the bodyStructured array (not
  // the pass-through stub) to confirm array-element `value` fields are substituted
  // before the number row coerces to an integer.
  it('F7: real interpolation of a {{variable}} array row then number coercion', async () => {
    const interpolated = VariableInterpolationUtil.interpolateVariables(
      [{ id: '1', key: 'total', value: '{{order_total}}', type: 'number' }],
      {
        sessionVariables: {},
        workflowVariables: { order_total: 30 },
        variables: [],
        contactId: 'c1',
        sessionId: 's1',
        timestamp: '2026-06-23T00:00:00.000Z',
      },
    );

    // Interpolation substitutes the array-element value to the string "30"...
    expect(interpolated[0].value).toBe('30');

    // ...then the build path coerces the number-typed row to the integer 30.
    const built = (node as any).buildStructuredJson(interpolated);
    expect(built).toEqual({ total: 30 });
  });
});
