import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface AssignAgentNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    agent_id?: string;
    agent_name?: string;
    nextNodeId?: string;
  };
}

export class AssignAgentNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('assign-agent', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(input: AssignAgentNodeInput): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );
      const { agent_id } = interpolatedNodeData;

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Execute assignment via CRM API
      const response = await this.crmService.assignAgent(
        context,
        agent_id || null,
        'assign-agent',
      );

      if (!response.success) {
        throw new Error(`Failed to assign agent: ${response.error}`);
      }

      // Log successful assignment
      this.logger.log('Agent assigned successfully', {
        conversationId: input.conversationId,
        agentId: agent_id,
        nodeId: input.nodeId,
      });

      return {
        agentAssigned: true,
        assignedAgentId: agent_id || null,
        assignmentTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_agent_assigned`]: result.agentAssigned,
          [`node_${input.nodeId}_assigned_agent_id`]: result.assignedAgentId,
          [`node_${input.nodeId}_assignment_timestamp`]:
            result.assignmentTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to assign agent', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
