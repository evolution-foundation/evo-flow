import { BaseNode, NodeExecutionResult } from './base.node';

export interface UpdateContactNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    fieldToUpdate?: string;
    newValue?: any;
    updates?: Record<string, any>;
    nextNodeId?: string;
  };
}

/**
 * Updates a contact via the CRM Rails REST API. Persistence lives in
 * evo-ai-crm-community; evo-flow no longer owns the `contacts` table.
 *
 * Field name mapping translates the flow builder UI naming (camelCase) to
 * the CRM wire format (snake_case). The resulting body is passed verbatim
 * to `PATCH /api/v1/contacts/{id}`.
 */
export class UpdateContactNode extends BaseNode {
  constructor() {
    super('UpdateContact');
  }

  async execute(input: UpdateContactNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      const { CrmClientService } = await import(
        '../../../../shared/crm-client/crm-client.service'
      );
      const { ContactsClientService } = await import(
        '../../../../shared/crm-client/contacts-client.service'
      );

      const client = new ContactsClientService(new CrmClientService());

      try {
        // 1. Validate the contact exists.
        const contact = await client.findById(input.contactId);
        if (!contact) {
          throw new Error(`Contact ${input.contactId} not found`);
        }

        // 2. Build the update payload in CRM wire format (snake_case).
        let updates: Record<string, any> = {};

        if (
          interpolatedNodeData.fieldToUpdate &&
          interpolatedNodeData.newValue !== undefined
        ) {
          // Flow-builder single-field update. Map UI field names to CRM wire
          // names. Anything not mapped is passed through unchanged.
          const fieldMapping: Record<string, string> = {
            name: 'name',
            firstName: 'name',
            lastName: 'name',
            email: 'email',
            phone: 'phone_number',
            phoneNumber: 'phone_number',
            identifier: 'identifier',
          };

          const actualField =
            fieldMapping[interpolatedNodeData.fieldToUpdate] ||
            interpolatedNodeData.fieldToUpdate;
          updates[actualField] = interpolatedNodeData.newValue;
        } else if (interpolatedNodeData.updates) {
          updates = interpolatedNodeData.updates;
        }

        if (Object.keys(updates).length === 0) {
          this.logger.warn('No fields to update', {
            contactId: input.contactId,
            nodeData: input.nodeData,
          });

          return {
            fieldsUpdated: [],
            updateCount: 0,
          };
        }

        await client.update(input.contactId, updates);

        const updatedFields = Object.keys(updates);

        this.logger.log('Contact updated successfully', {
          contactId: input.contactId,
          updatedFields,
          updateCount: updatedFields.length,
        });

        return {
          fieldsUpdated: updatedFields,
          updateCount: updatedFields.length,
          updates,
        };
      } catch (error) {
        this.logger.error('Failed to update contact', {
          contactId: input.contactId,
          nodeId: input.nodeId,
          error: error.message,
        });
        throw error;
      }
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_fields_updated`]: result.fieldsUpdated,
          [`node_${input.nodeId}_update_count`]: result.updateCount,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }
}
