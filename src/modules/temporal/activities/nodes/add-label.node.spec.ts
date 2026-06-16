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

  it('happy path: calls findById then addLabel and returns success', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c1' });
    labelsService.addLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.findById).toHaveBeenCalledWith('c1');
    // Q3-labels-service title-based contract: prefer labelName, fall back to labelId
    expect(labelsService.addLabel).toHaveBeenCalledWith('c1', 'VIP');
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      [`node_n1_label_added`]: 'lbl-id-1',
      [`node_n1_label_name`]: 'VIP',
    });
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
    contactsService.findById.mockResolvedValue({ id: 'c1' });
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
