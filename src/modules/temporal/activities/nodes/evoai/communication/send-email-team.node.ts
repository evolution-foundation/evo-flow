import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface SendEmailTeamNodeInput {
  nodeId: string;
  conversationId?: string;
  sessionId: string;
  nodeData: {
    team_ids?: string[];
    teamIds?: string[];
    message?: string;
    nextNodeId?: string;
  };
}

export class SendEmailTeamNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('send-email-team');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) this.crmService = new CrmClientService();
    return this.crmService;
  }

  async execute(input: SendEmailTeamNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const data = await this.interpolateNodeData(input, input.nodeData);
      const teamIds: string[] = data.team_ids || data.teamIds || [];
      const message = data.message;

      if (!teamIds.length || !message) {
        this.logger.warn('No team_ids/message configured; skipping', {
          nodeId: input.nodeId,
        });
        return {
          emailed: false,
          skipped: true,
          reason: 'missing_team_ids_or_message',
          timestamp: new Date().toISOString(),
        };
      }
      if (!input.conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });
        return {
          emailed: false,
          skipped: true,
          reason: 'no_conversation_id',
          timestamp: new Date().toISOString(),
        };
      }

      const response = await this.getCrmService().sendEmailTeam(
        { conversationId: input.conversationId },
        teamIds.map(String),
        message,
        'send-email-team',
      );

      if (!response.success) {
        throw new Error(`Failed to send team email: ${response.error}`);
      }

      return {
        emailed: true,
        teamIds,
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_team_emailed`]: result.emailed,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to send team email', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
