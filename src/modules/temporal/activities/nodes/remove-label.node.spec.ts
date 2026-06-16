import { RemoveLabelNode, RemoveLabelNodeInput } from './remove-label.node';

describe('RemoveLabelNode', () => {
  let node: RemoveLabelNode;
  let contactsService: { findById: jest.Mock };
  let labelsService: { removeLabel: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const baseInput: RemoveLabelNodeInput = {
    nodeId: 'n2',
    contactId: 'c2',
    labelId: 'lbl-id-2',
    labelName: 'VIP',
    sessionId: 's2',
    nodeData: {
      labelId: 'lbl-id-2',
    },
  };

  beforeEach(() => {
    node = new RemoveLabelNode();
    contactsService = { findById: jest.fn() };
    labelsService = { removeLabel: jest.fn() };

    jest.spyOn(node as any, 'getServices').mockResolvedValue({
      contactsService,
      labelsService,
    });

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

  it('happy path: calls findById then removeLabel and returns success', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c2' });
    labelsService.removeLabel.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.findById).toHaveBeenCalledWith('c2');
    // Q3-labels-service title-based contract: prefer labelName, fall back to labelId
    expect(labelsService.removeLabel).toHaveBeenCalledWith('c2', 'VIP');
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      [`node_n2_label_removed`]: 'lbl-id-2',
      [`node_n2_label_name`]: 'VIP',
    });
  });

  it('contact 404: skips with contact_not_found instead of reporting success (EVO-1757)', async () => {
    contactsService.findById.mockResolvedValue(null);

    const result = await node.execute(baseInput);

    expect(labelsService.removeLabel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contact not found'),
      expect.objectContaining({ contactId: 'c2' }),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('contact_not_found');
  });

  it('service throw: propagates as createErrorResult', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c2' });
    labelsService.removeLabel.mockRejectedValue(new Error('CRM 500'));

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RemoveLabel/);
    expect(result.error).toMatch(/CRM 500/);
  });

  it('interpolation: uses interpolated labelId from nodeData and falls back to labelId when labelName absent', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c2' });
    labelsService.removeLabel.mockResolvedValue(undefined);

    (node as any).interpolateNodeData.mockResolvedValueOnce({
      labelId: 'interpolated-lbl-77',
    });

    const inputWithoutName: RemoveLabelNodeInput = {
      ...baseInput,
      labelName: undefined,
      nodeData: { labelId: '{{var.label}}' },
    };

    await node.execute(inputWithoutName);

    expect(labelsService.removeLabel).toHaveBeenCalledWith('c2', 'interpolated-lbl-77');
  });
});
