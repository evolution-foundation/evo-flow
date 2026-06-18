import { BaseNode, NodeExecutionResult } from './base.node';
import { getAppContext } from '../../../../shared/app-context.holder';

export interface AddLabelNodeInput {
  nodeId: string;
  contactId: string;
  labelId: string;
  labelName?: string;
  sessionId: string;
  nodeData: {
    labelId: string;
    nextNodeId?: string;
  };
}

export class AddLabelNode extends BaseNode {
  private labelsService: any = null;
  private contactsService: any = null;

  constructor() {
    super('AddLabel');
  }

  private async getServices() {
    const appContext = getAppContext();

    if (!this.labelsService) {
      const { LabelsService } = await import('../../../labels/labels.service');
      this.labelsService = appContext.get(LabelsService);
    }

    if (!this.contactsService) {
      const { ContactsService } = await import('../../../contacts/contacts.service');
      this.contactsService = appContext.get(ContactsService);
    }

    return {
      labelsService: this.labelsService,
      contactsService: this.contactsService
    };
  }

  async execute(input: AddLabelNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      // Get services using lazy initialization
      const { labelsService, contactsService } = await this.getServices();

      try {

        // Use interpolated labelId from nodeData (this will resolve variables correctly)
        const labelId = interpolatedNodeData.labelId || input.labelId;

        // Q3-labels-service contract: addLabel(contactId, titleOrId).
        // Prefer the upstream labelName (title); fall back to labelId for
        // backward compat with callers that only carry the id.
        const labelNameOrId = input.labelName || labelId;

        this.logger.log('AddLabelNode execution started', {
          nodeId: input.nodeId,
          contactId: input.contactId,
          originalLabelId: input.labelId,
          interpolatedLabelId: labelId,
          nodeData: input.nodeData,
          interpolatedNodeData,
        });

        const contact: any = await contactsService.findById(input.contactId);

        if (!contact) {
          this.logger.warn(
            'AddLabelNode: contact not found',
            { contactId: input.contactId },
          );
          return { skipped: true, reason: 'contact_not_found' } as any;
        }

        await labelsService.addLabel(input.contactId, labelNameOrId);

        this.logger.log('Label added to contact successfully', {
          contactId: input.contactId,
          labelId: labelId,
          labelName: input.labelName ?? null,
          sessionId: input.sessionId,
        });

        return {
          labelAdded: true,
          labelId,
          labelName: input.labelName ?? null,
        };
      } catch (error) {
        this.logger.error('Failed to add label to contact', {
          contactId: input.contactId,
          originalLabelId: input.labelId,
          interpolatedLabelId: interpolatedNodeData?.labelId,
          nodeId: input.nodeId,
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
          [`node_${input.nodeId}_label_added`]: input.labelId,
          [`node_${input.nodeId}_label_name`]: result.labelName,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(
          error instanceof Error ? error : new Error(String(error)),
          executionTime,
        );
      });
  }
}
