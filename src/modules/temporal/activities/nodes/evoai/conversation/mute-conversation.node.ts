import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface MuteConversationNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  nodeData: {
    nextNodeId?: string;
  };
}

export class MuteConversationNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('mute-conversation', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(
    input: MuteConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Execute mute via CRM API
      const response = await this.crmService.muteConversation(
        context,
        'mute-conversation',
      );

      if (!response.success) {
        throw new Error(`Failed to mute conversation: ${response.error}`);
      }

      // Log successful mute
      this.logger.log('Conversation muted successfully', {
        conversationId: input.conversationId,
        nodeId: input.nodeId,
      });

      return {
        conversationMuted: true,
        muteTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_conversation_muted`]: result.conversationMuted,
          [`node_${input.nodeId}_mute_timestamp`]: result.muteTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to mute conversation', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
