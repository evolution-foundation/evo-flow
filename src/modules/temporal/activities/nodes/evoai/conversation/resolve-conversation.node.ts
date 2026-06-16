import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface ResolveConversationNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    nextNodeId?: string;
  };
}

export class ResolveConversationNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('resolve-conversation', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(
    input: ResolveConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Execute status change via CRM API
      const response = await this.crmService.changeConversationStatus(
        context,
        'resolved',
        'resolve-conversation',
      );

      if (!response.success) {
        throw new Error(`Failed to resolve conversation: ${response.error}`);
      }

      // Log successful resolution
      this.logger.log('Conversation resolved successfully', {
        conversationId: input.conversationId,
        nodeId: input.nodeId,
      });

      return {
        conversationResolved: true,
        status: 'resolved',
        resolveTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_conversation_resolved`]:
            result.conversationResolved,
          [`node_${input.nodeId}_status`]: result.status,
          [`node_${input.nodeId}_resolve_timestamp`]: result.resolveTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to resolve conversation', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
