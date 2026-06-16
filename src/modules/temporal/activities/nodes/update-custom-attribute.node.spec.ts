import {
  UpdateCustomAttributeNode,
  UpdateCustomAttributeNodeInput,
} from './update-custom-attribute.node';

describe('UpdateCustomAttributeNode', () => {
  let node: UpdateCustomAttributeNode;
  let contactsService: { findById: jest.Mock; updateCustomAttribute: jest.Mock };
  let customAttributesService: Record<string, jest.Mock>;
  let warnSpy: jest.SpyInstance;

  const baseInput: UpdateCustomAttributeNodeInput = {
    nodeId: 'n3',
    contactId: 'c3',
    sessionId: 's3',
    nodeData: {
      attributeId: 'attr-id-1',
      attributeName: 'plan_tier',
      newValue: 'gold',
    },
  };

  beforeEach(() => {
    node = new UpdateCustomAttributeNode();
    contactsService = {
      findById: jest.fn(),
      updateCustomAttribute: jest.fn(),
    };
    customAttributesService = {};

    jest.spyOn(node as any, 'getServices').mockResolvedValue({
      contactsService,
      customAttributesService,
    });

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

  it('happy path: calls findById then updateCustomAttribute with attributeName as key', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c3' });
    contactsService.updateCustomAttribute.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.findById).toHaveBeenCalledWith('c3');
    expect(contactsService.updateCustomAttribute).toHaveBeenCalledWith(
      'c3',
      'plan_tier',
      'gold',
    );
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      [`node_n3_attribute_updated`]: 'attr-id-1',
      [`node_n3_attribute_name`]: 'plan_tier',
      [`node_n3_attribute_api_key`]: 'plan_tier',
      [`node_n3_previous_value`]: null,
      [`node_n3_new_value`]: 'gold',
    });
  });

  it('contact 404: skips with contact_not_found instead of reporting success (EVO-1757)', async () => {
    contactsService.findById.mockResolvedValue(null);

    const result = await node.execute(baseInput);

    expect(contactsService.updateCustomAttribute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contact not found'),
      expect.objectContaining({ contactId: 'c3', attributeId: 'attr-id-1' }),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('contact_not_found');
  });

  it('service throw: propagates as createErrorResult', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c3' });
    contactsService.updateCustomAttribute.mockRejectedValue(
      new Error('CRM 500'),
    );

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UpdateCustomAttribute/);
    expect(result.error).toMatch(/CRM 500/);
  });
});
