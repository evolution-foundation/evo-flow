import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface AssignBotNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    bot_id?: string;
    bot_name?: string;
    inbox_id?: string;
    inbox_name?: string;
    nextNodeId?: string;
  };
}

export class AssignBotNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('assign-bot');
    this.crmService = new CrmClientService();
  }

  async execute(input: AssignBotNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );
      const { bot_id, inbox_id } = interpolatedNodeData;

      // Validate required fields
      if (!inbox_id) {
        throw new Error('Inbox ID is required for bot assignment');
      }

      // Execute bot assignment via CRM API
      const response = await this.crmService.assignBot(
        inbox_id,
        bot_id || null,
      );

      if (!response.success) {
        throw new Error(`Failed to assign bot: ${response.error}`);
      }

      // Determine assignment action
      const isUnassignment = !bot_id;
      const action = isUnassignment ? 'unassigned' : 'assigned';

      // Log successful assignment/unassignment
      this.logger.log(`Bot ${action} successfully`, {
        conversationId: input.conversationId,
        botId: bot_id || 'none',
        inboxId: inbox_id,
        action,
        nodeId: input.nodeId,
      });

      return {
        botAssigned: !isUnassignment,
        botUnassigned: isUnassignment,
        assignedBotId: bot_id || null,
        inboxId: inbox_id,
        assignmentAction: action,
        assignmentTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_bot_assigned`]: result.botAssigned,
          [`node_${input.nodeId}_bot_unassigned`]: result.botUnassigned,
          [`node_${input.nodeId}_assigned_bot_id`]: result.assignedBotId,
          [`node_${input.nodeId}_inbox_id`]: result.inboxId,
          [`node_${input.nodeId}_assignment_action`]: result.assignmentAction,
          [`node_${input.nodeId}_assignment_timestamp`]: result.assignmentTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to assign bot', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          botId: input.nodeData.bot_id,
          inboxId: input.nodeData.inbox_id,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}