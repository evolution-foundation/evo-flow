import { BaseNode, NodeExecutionResult } from './base.node';
import { getAppContext } from '../../../../shared/app-context.holder';
import { mapContactDto } from '../../../../shared/crm-client/types/contact';

export interface UpdateCustomAttributeNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    attributeId: string;
    attributeName: string;
    newValue: any;
    attributeDisplayType?: string;
    nextNodeId?: string;
  };
}

export class UpdateCustomAttributeNode extends BaseNode {
  private customAttributesService: any = null;
  private contactsService: any = null;

  constructor() {
    super('UpdateCustomAttribute');
  }

  private async getServices() {
    const appContext = getAppContext();

    if (!this.customAttributesService) {
      const { CustomAttributesService } = await import('../../../custom-attributes/custom-attributes.service');
      this.customAttributesService = appContext.get(CustomAttributesService);
    }

    if (!this.contactsService) {
      const { ContactsService } = await import('../../../contacts/contacts.service');
      this.contactsService = appContext.get(ContactsService);
    }

    return {
      customAttributesService: this.customAttributesService,
      contactsService: this.contactsService
    };
  }

  async execute(
    input: UpdateCustomAttributeNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Get services using lazy initialization
      const { contactsService } = await this.getServices();

      try {
        const dto = await contactsService.findById(input.contactId);

        if (!dto) {
          this.logger.warn(
            'UpdateCustomAttributeNode: contact not found',
            { contactId: input.contactId, attributeId: input.nodeData.attributeId },
          );
          return { skipped: true, reason: 'contact_not_found' } as any;
        }

        // findById returns the raw CRM ContactDto in snake_case wire format
        // (`custom_attributes`), so map it to the HydratedContact shape before
        // reading. Reading `dto.customAttributes` directly is always undefined
        // → existingAttributes would be {} → the read-modify-write below would
        // send a single-key map and the CRM PATCH (which REPLACES the column)
        // would wipe every other custom attribute on each run. Mirrors the
        // read side in conditional.node.ts (EVO-1837).
        const contact = mapContactDto(dto);

        // attributeName carries the attribute_key (slug) — the canonical
        // custom_attributes JSONB key (EVO-1850). The CRM Rails
        // `PATCH /contacts/:id` REPLACES the whole custom_attributes column
        // (it does NOT merge), so we read-modify-write: spread the contact's
        // existing customAttributes and override just this key, otherwise every
        // other custom attribute would be wiped on each run.
        const attributeApiKey = input.nodeData.attributeName;
        const existingAttributes = (contact?.customAttributes ?? {}) as Record<
          string,
          unknown
        >;
        const previousValue =
          attributeApiKey in existingAttributes
            ? existingAttributes[attributeApiKey]
            : null;
        const mergedAttributes = {
          ...existingAttributes,
          [attributeApiKey]: input.nodeData.newValue,
        };
        await contactsService.setCustomAttributes(
          input.contactId,
          mergedAttributes,
        );

        this.logger.log('Custom attribute updated successfully', {
          contactId: input.contactId,
          attributeId: input.nodeData.attributeId,
          attributeName: input.nodeData.attributeName,
          attributeApiKey: input.nodeData.attributeName,
          newValue: input.nodeData.newValue,
        });

        return {
          attributeUpdated: true,
          attributeId: input.nodeData.attributeId,
          attributeName: input.nodeData.attributeName,
          attributeApiKey,
          previousValue,
          newValue: input.nodeData.newValue,
        };
      } catch (error) {
        this.logger.error('Failed to update custom attribute', {
          nodeId: input.nodeId,
          attributeId: input.nodeData.attributeId,
          contactId: input.contactId,
          error: error instanceof Error ? error.message : String(error),
          httpStatusCode: (error as any)?.response?.status,
        });
        throw error;
      }
    })
      .then(({ result, executionTime }) => {
        if (result?.skipped) {
          return this.createSkippedResult(result.reason, executionTime);
        }
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_attribute_updated`]:
            input.nodeData.attributeId,
          [`node_${input.nodeId}_attribute_name`]: result.attributeName,
          [`node_${input.nodeId}_attribute_api_key`]: result.attributeApiKey,
          [`node_${input.nodeId}_previous_value`]: result.previousValue,
          [`node_${input.nodeId}_new_value`]: result.newValue,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }
}
