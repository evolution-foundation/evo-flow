import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface DeferConversationNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    nextNodeId?: string;
  };
}

// "Defer" is the Journey-palette name for the same effect as "snooze": the
// conversation moves to the CRM 'snoozed' status. Kept as a distinct node type
// so the palette's `defer-conversation-node` resolves to a real executor
// instead of the workflow's no-op default.
export class DeferConversationNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('defer-conversation');
    this.crmService = new CrmClientService();
  }

  async execute(
    input: DeferConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const context = {
        conversationId: input.conversationId,
      };

      const response = await this.crmService.changeConversationStatus(
        context,
        'snoozed',
        'defer-conversation',
      );

      if (!response.success) {
        throw new Error(`Failed to defer conversation: ${response.error}`);
      }

      this.logger.log('Conversation deferred successfully', {
        conversationId: input.conversationId,
        nodeId: input.nodeId,
      });

      return {
        conversationDeferred: true,
        status: 'snoozed',
        deferTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_conversation_deferred`]:
            result.conversationDeferred,
          [`node_${input.nodeId}_status`]: result.status,
          [`node_${input.nodeId}_defer_timestamp`]: result.deferTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to defer conversation', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
