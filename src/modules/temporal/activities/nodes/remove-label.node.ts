import { BaseNode, NodeExecutionResult } from './base.node';

export interface RemoveLabelNodeInput {
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

export class RemoveLabelNode extends BaseNode {
  private labelsService: any = null;
  private contactsService: any = null;
  private appContext: any = null;

  constructor() {
    super('RemoveLabel');
  }

  private async getServices() {
    if (!this.appContext) {
      const { NestFactory } = await import('@nestjs/core');
      const { AppModule } = await import('../../../../app.module');

      this.appContext = await NestFactory.createApplicationContext(
        AppModule.forRoot(),
        {
          logger: false,
        },
      );
    }

    if (!this.labelsService) {
      const { LabelsService } = await import('../../../labels/labels.service');
      this.labelsService = this.appContext.get(LabelsService);
    }

    if (!this.contactsService) {
      const { ContactsService } = await import('../../../contacts/contacts.service');
      this.contactsService = this.appContext.get(ContactsService);
    }

    return {
      labelsService: this.labelsService,
      contactsService: this.contactsService
    };
  }

  async execute(input: RemoveLabelNodeInput): Promise<NodeExecutionResult> {
    this.logger.log('RemoveLabelNode execution started', {
      nodeId: input.nodeId,
      contactId: input.contactId,
      labelId: input.labelId,
      labelName: input.labelName,
      nodeData: input.nodeData,
      sessionId: input.sessionId,
    });

    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(input, input.nodeData);

      // Get services using lazy initialization
      const { labelsService, contactsService } = await this.getServices();

      try {

        // Use interpolated labelId from nodeData (this will resolve variables correctly)
        const labelId = interpolatedNodeData.labelId || input.labelId;

        // Q3-labels-service contract: removeLabel(contactId, titleOrId).
        // Prefer the upstream labelName (title); fall back to labelId for
        // backward compat with callers that only carry the id.
        const labelNameOrId = input.labelName || labelId;

        this.logger.log('RemoveLabelNode execution with interpolation', {
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
            'RemoveLabelNode: contact not found',
            { contactId: input.contactId },
          );
          return { skipped: true, reason: 'contact_not_found' } as any;
        }

        await labelsService.removeLabel(input.contactId, labelNameOrId);

        this.logger.log('Label removed from contact successfully', {
          contactId: input.contactId,
          labelId: labelId,
          labelName: input.labelName ?? null,
          sessionId: input.sessionId,
        });

        return {
          labelRemoved: true,
          labelId,
          labelName: input.labelName ?? null,
        };
      } catch (error) {
        this.logger.error('Failed to remove label from contact', {
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
          [`node_${input.nodeId}_label_removed`]: input.labelId,
          [`node_${input.nodeId}_label_name`]: result.labelName,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error instanceof Error ? error : new Error(String(error)), executionTime);
      });
  }
}
