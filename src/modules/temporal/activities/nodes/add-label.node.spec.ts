// AddLabelNode now instantiates CrmClientService in its constructor (EVO-1919
// effect verification), which requires these env vars. Set them before import.
process.env.EVOAI_CRM_API_TOKEN ||= 'test-token';
process.env.EVOAI_CRM_BASE_URL ||= 'http://crm-test.local';

import { AddLabelNode, AddLabelNodeInput } from './add-label.node';

describe('AddLabelNode', () => {
  let node: AddLabelNode;
  let contactsService: { findById: jest.Mock };
  let labelsService: { addLabel: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const baseInput: AddLabelNodeInput = {
    nodeId: 'n1',
    contactId: 'c1',
    labelId: 'lbl-id-1',
    labelName: 'VIP',
    sessionId: 's1',
    nodeData: {
      labelId: 'lbl-id-1',
    },
  };

  beforeEach(() => {
    node = new AddLabelNode();
    contactsService = { findById: jest.fn() };
    labelsService = { addLabel: jest.fn() };

    jest.spyOn(node as any, 'getServices').mockResolvedValue({
      contactsService,
      labelsService,
    });

    // EVO-1919: effect verification re-reads the contact via crmService.
    // Default to "enabled but confirmed present" so happy paths still pass;
    // dedicated tests below override the probe/flag.
    jest
      .spyOn((node as any).crmService, 'isEffectVerificationEnabled')
      .mockReturnValue(true);

    // Avoid hitting DB / cache via interpolation
    jest
      .spyOn(node as any, 'interpolateNodeData')
      .mockImplementation(async (_input, nodeData) => nodeData);

    // logNodeError calls @temporalio/activity log.error which requires an
    // activity context; stub it out for unit tests.
    jest
      .spyOn(node as any, 'logNodeError')
      .mockImplementation(() => undefined);

    warnSpy = jest
      .spyOn((node as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((node as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('happy path: calls findById then addLabel, verifies effect, returns success', async () => {
    // Initial existence read, then verification re-read showing the label present.
    // Real CRM ContactSerializer shape: labels are { name, color } only.
    contactsService.findById
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        labels: [{ name: 'VIP', color: '#1f93ff' }],
      });
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.findById).toHaveBeenNthCalledWith(1, 'c1');
    // Q3-labels-service title-based contract: prefer labelName, fall back to labelId
    expect(labelsService.addLabel).toHaveBeenCalledWith('c1', 'VIP');
    // EVO-1919: verification re-read uses no-cache to avoid stale labels.
    expect(contactsService.findById).toHaveBeenNthCalledWith(2, 'c1', {
      noCache: true,
    });
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      [`node_n1_label_added`]: 'lbl-id-1',
      [`node_n1_label_name`]: 'VIP',
    });
  });

  it('EVO-1919: fails the node when CRM returns 2xx but the label did not persist (D8)', async () => {
    contactsService.findById
      .mockResolvedValueOnce({ id: 'c1' })
      // Verification re-read: no labels → effect not persisted.
      .mockResolvedValueOnce({ id: 'c1', labels: [] });
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(labelsService.addLabel).toHaveBeenCalledWith('c1', 'VIP');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not persisted/i);
  });

  it('EVO-1919: confirms via the real { name } shape and fails when only a different label is present', async () => {
    // 2xx but the requested label ("VIP") is absent — another label exists.
    // Real CRM shape ⇒ matched by `name`, so this is a legitimate failure
    // and proves the predicate is not always-true.
    contactsService.findById
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        labels: [{ name: 'Lead', color: '#ff0000' }],
      });
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not persisted/i);
  });

  it('EVO-1919: a flaky verification probe does NOT fail the node (write already 2xx)', async () => {
    contactsService.findById
      .mockResolvedValueOnce({ id: 'c1' })
      // Verification re-read throws (network/timeout) → cannot confirm, but the
      // write succeeded so the node must not be failed.
      .mockRejectedValueOnce(new Error('CRM unavailable'));
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(result.success).toBe(true);
  });

  it('EVO-1919: skips verification entirely when the flag is disabled (single read)', async () => {
    (node as any).crmService.isEffectVerificationEnabled.mockReturnValue(false);
    contactsService.findById.mockResolvedValueOnce({ id: 'c1' });
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(result.success).toBe(true);
    // Only the initial existence read; no verification re-read.
    expect(contactsService.findById).toHaveBeenCalledTimes(1);
  });

  it('contact 404: skips with contact_not_found instead of reporting success (EVO-1757)', async () => {
    contactsService.findById.mockResolvedValue(null);

    const result = await node.execute(baseInput);

    expect(labelsService.addLabel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contact not found'),
      expect.objectContaining({ contactId: 'c1' }),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('contact_not_found');
  });

  it('service throw: propagates as createErrorResult', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c1' });
    labelsService.addLabel.mockRejectedValue(new Error('CRM 500'));

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/AddLabel/);
    expect(result.error).toMatch(/CRM 500/);
  });

  it('interpolation: uses interpolated labelId from nodeData and falls back to labelId when labelName absent', async () => {
    contactsService.findById
      .mockResolvedValueOnce({ id: 'c1' })
      .mockResolvedValueOnce({
        id: 'c1',
        labels: [{ name: 'interpolated-lbl-99', color: '#1f93ff' }],
      });
    labelsService.addLabel.mockResolvedValue(undefined);

    // Override interpolation to simulate variable resolution
    (node as any).interpolateNodeData.mockResolvedValueOnce({
      labelId: 'interpolated-lbl-99',
    });

    const inputWithoutName: AddLabelNodeInput = {
      ...baseInput,
      labelName: undefined,
      nodeData: { labelId: '{{var.label}}' },
    };

    await node.execute(inputWithoutName);

    // Falls back to interpolated labelId because labelName is empty
    expect(labelsService.addLabel).toHaveBeenCalledWith('c1', 'interpolated-lbl-99');
  });
});
