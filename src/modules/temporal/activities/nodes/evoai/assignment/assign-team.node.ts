import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface AssignTeamNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    team_id?: string;
    team_name?: string;
    nextNodeId?: string;
  };
}

export class AssignTeamNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('assign-team', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(input: AssignTeamNodeInput): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );
      const { team_id } = interpolatedNodeData;

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Execute assignment via CRM API
      const response = await this.crmService.assignTeam(
        context,
        team_id || null,
        'assign-team',
      );

      if (!response.success) {
        throw new Error(`Failed to assign team: ${response.error}`);
      }

      // Log successful assignment
      this.logger.log('Team assigned successfully', {
        conversationId: input.conversationId,
        teamId: team_id,
        nodeId: input.nodeId,
      });

      return {
        teamAssigned: true,
        assignedTeamId: team_id || null,
        assignmentTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_team_assigned`]: result.teamAssigned,
          [`node_${input.nodeId}_assigned_team_id`]: result.assignedTeamId,
          [`node_${input.nodeId}_assignment_timestamp`]:
            result.assignmentTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to assign team', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
