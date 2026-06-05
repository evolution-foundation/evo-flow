import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface SendCannedResponseNodeInput {
  nodeId: string;
  conversationId?: string;
  sessionId: string;
  contactId?: string;
  nodeData: {
    canned_response_id?: string;
    cannedResponseId?: string;
    nextNodeId?: string;
  };
}

export class SendCannedResponseNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('send-canned-response');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) {
      this.crmService = new CrmClientService();
    }
    return this.crmService;
  }

  private async resolveContent(cannedId: string): Promise<string | null> {
    const response = await this.getCrmService().getCannedResponse(cannedId);
    if (!response.success) return null;
    const raw = response.data;
    const canned = raw?.data ?? raw;
    return canned?.content ?? null;
  }

  async execute(
    input: SendCannedResponseNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      const cannedId =
        interpolatedNodeData.canned_response_id ||
        interpolatedNodeData.cannedResponseId;

      if (!cannedId) {
        this.logger.warn('No canned_response_id configured; skipping', {
          nodeId: input.nodeId,
        });
        return {
          messageSent: false,
          skipped: true,
          reason: 'no_canned_response_id',
          sendTimestamp: new Date().toISOString(),
        };
      }

      if (!input.conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });
        return {
          messageSent: false,
          skipped: true,
          reason: 'no_conversation_id',
          sendTimestamp: new Date().toISOString(),
        };
      }

      const content = await this.resolveContent(String(cannedId));

      // Missing/deleted canned response: skip with a warning instead of sending
      // an empty message (parity with the Rails send_canned_response handler).
      if (!content || content.trim() === '') {
        this.logger.warn('Canned response not found; skipping send', {
          nodeId: input.nodeId,
          cannedResponseId: cannedId,
        });
        return {
          messageSent: false,
          skipped: true,
          reason: 'canned_response_not_found',
          cannedResponseId: cannedId,
          sendTimestamp: new Date().toISOString(),
        };
      }

      const response = await this.getCrmService().sendMessage(
        { conversationId: input.conversationId },
        content.trim(),
        false,
        'send-canned-response',
      );

      if (!response.success) {
        throw new Error(`Failed to send canned response: ${response.error}`);
      }

      return {
        messageSent: true,
        messageId: response.data?.id,
        cannedResponseId: cannedId,
        conversationId: input.conversationId,
        sendTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_message_sent`]: result.messageSent,
          [`node_${input.nodeId}_canned_response_id`]: result.cannedResponseId,
          [`node_${input.nodeId}_send_timestamp`]: result.sendTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to send canned response', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
