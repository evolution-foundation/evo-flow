import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface ChangePriorityNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
    nextNodeId?: string;
  };
}

export class ChangePriorityNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('change-priority', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(input: ChangePriorityNodeInput): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      const { priority } = interpolatedNodeData;

      // Validate priority value
      const validPriorities = ['low', 'medium', 'high', 'urgent', null];
      if (priority !== undefined && !validPriorities.includes(priority)) {
        throw new Error(`Invalid priority value: ${priority}. Must be one of: ${validPriorities.join(', ')}`);
      }

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Execute priority change via CRM API
      const response = await this.crmService.changeConversationPriority(
        context,
        priority || null,
        'change-priority',
      );

      if (!response.success) {
        throw new Error(`Failed to change conversation priority: ${response.error}`);
      }

      // Log successful priority change
      this.logger.log('Conversation priority changed successfully', {
        conversationId: input.conversationId,
        priority: priority || 'none',
        nodeId: input.nodeId,
      });

      return {
        priorityChanged: true,
        priority: priority || null,
        changeTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_priority_changed`]: result.priorityChanged,
          [`node_${input.nodeId}_priority`]: result.priority,
          [`node_${input.nodeId}_change_timestamp`]: result.changeTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to change conversation priority', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}