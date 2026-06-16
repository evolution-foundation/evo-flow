import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface SnoozeConversationNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    nextNodeId?: string;
  };
}

export class SnoozeConversationNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('snooze-conversation', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(
    input: SnoozeConversationNodeInput,
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
        'snoozed',
        'snooze-conversation',
      );

      if (!response.success) {
        throw new Error(`Failed to snooze conversation: ${response.error}`);
      }

      // Log successful snooze
      this.logger.log('Conversation snoozed successfully', {
        conversationId: input.conversationId,
        nodeId: input.nodeId,
      });

      return {
        conversationSnoozed: true,
        status: 'snoozed',
        snoozeTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_conversation_snoozed`]:
            result.conversationSnoozed,
          [`node_${input.nodeId}_status`]: result.status,
          [`node_${input.nodeId}_snooze_timestamp`]: result.snoozeTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to snooze conversation', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
