import {
  UpdateCustomAttributeNode,
  UpdateCustomAttributeNodeInput,
} from './update-custom-attribute.node';

describe('UpdateCustomAttributeNode', () => {
  let node: UpdateCustomAttributeNode;
  let contactsService: {
    findById: jest.Mock;
    updateCustomAttribute: jest.Mock;
    setCustomAttributes: jest.Mock;
  };
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
      setCustomAttributes: jest.fn(),
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

  it('happy path: read-modify-write — merges new attribute into existing custom_attributes by slug (EVO-1850)', async () => {
    // Pre-existing custom attributes must survive: the CRM PATCH replaces the
    // whole column, so the node sends the full merged map.
    // findById returns the raw CRM wire format (snake_case `custom_attributes`);
    // the node maps it via mapContactDto before merging. Mocking the camelCase
    // shape the client never produces would mask the read-side field bug.
    contactsService.findById.mockResolvedValue({
      id: 'c3',
      custom_attributes: { existing_attr: 'keep', another: 42 },
    });
    contactsService.setCustomAttributes.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.findById).toHaveBeenCalledWith('c3');
    expect(contactsService.setCustomAttributes).toHaveBeenCalledWith('c3', {
      existing_attr: 'keep',
      another: 42,
      plan_tier: 'gold',
    });
    // The deprecated single-key replace path must NOT be used.
    expect(contactsService.updateCustomAttribute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      [`node_n3_attribute_updated`]: 'attr-id-1',
      [`node_n3_attribute_name`]: 'plan_tier',
      [`node_n3_attribute_api_key`]: 'plan_tier',
      [`node_n3_previous_value`]: null,
      [`node_n3_new_value`]: 'gold',
    });
  });

  it('overwrite: reports the previous value when the slug already had one', async () => {
    contactsService.findById.mockResolvedValue({
      id: 'c3',
      custom_attributes: { plan_tier: 'silver', keep_me: 'x' },
    });
    contactsService.setCustomAttributes.mockResolvedValue(undefined);

    const result = await node.execute(baseInput);

    expect(contactsService.setCustomAttributes).toHaveBeenCalledWith('c3', {
      plan_tier: 'gold',
      keep_me: 'x',
    });
    expect(result.variables).toMatchObject({
      [`node_n3_previous_value`]: 'silver',
      [`node_n3_new_value`]: 'gold',
    });
  });

  it('contact 404: skips with contact_not_found instead of reporting success (EVO-1757)', async () => {
    contactsService.findById.mockResolvedValue(null);

    const result = await node.execute(baseInput);

    expect(contactsService.setCustomAttributes).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contact not found'),
      expect.objectContaining({ contactId: 'c3', attributeId: 'attr-id-1' }),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('contact_not_found');
  });

  it('service throw: propagates as createErrorResult', async () => {
    contactsService.findById.mockResolvedValue({ id: 'c3', custom_attributes: {} });
    contactsService.setCustomAttributes.mockRejectedValue(
      new Error('CRM 500'),
    );

    const result = await node.execute(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UpdateCustomAttribute/);
    expect(result.error).toMatch(/CRM 500/);
  });
});
