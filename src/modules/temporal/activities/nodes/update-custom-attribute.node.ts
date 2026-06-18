import { BaseNode, NodeExecutionResult } from './base.node';
import { getAppContext } from '../../../../shared/app-context.holder';

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
        const contact: any = await contactsService.findById(input.contactId);

        if (!contact) {
          this.logger.warn(
            'UpdateCustomAttributeNode: contact not found',
            { contactId: input.contactId, attributeId: input.nodeData.attributeId },
          );
          return { skipped: true, reason: 'contact_not_found' } as any;
        }

        // Q3-contacts-service contract: updateCustomAttribute(contactId, attrKey, value).
        // attrKey == input.nodeData.attributeName (CRM Rails merges by key in the
        // custom_attributes JSON column). No client-side read-modify-write — the
        // CRM PATCH merges server-side, so previousValue is not derivable here.
        await contactsService.updateCustomAttribute(
          input.contactId,
          input.nodeData.attributeName,
          input.nodeData.newValue,
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
          attributeApiKey: input.nodeData.attributeName,
          previousValue: null,
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
