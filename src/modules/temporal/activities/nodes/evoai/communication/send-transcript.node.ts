import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface SendTranscriptNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    email?: string;
    recipient_email?: string; // Alternative field name from frontend
    emails?: string[]; // Support multiple emails
    nextNodeId?: string;
  };
}

export class SendTranscriptNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('send-transcript', 'conversation');
    this.crmService = new CrmClientService();
  }

  async execute(input: SendTranscriptNodeInput): Promise<NodeExecutionResult> {
    const skip = this.contextSkip(input);
    if (skip) return skip;
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      // Extract email addresses (support multiple formats)
      let emailAddresses: string[] = [];

      if (interpolatedNodeData.email) {
        // Single email field
        emailAddresses = [interpolatedNodeData.email];
      } else if (interpolatedNodeData.recipient_email) {
        // Alternative single email field
        emailAddresses = [interpolatedNodeData.recipient_email];
      } else if (interpolatedNodeData.emails) {
        // Array of emails
        emailAddresses = Array.isArray(interpolatedNodeData.emails)
          ? interpolatedNodeData.emails
          : [interpolatedNodeData.emails];
      }

      // Validate email addresses
      if (emailAddresses.length === 0) {
        throw new Error('At least one email address is required');
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmails = emailAddresses.filter(
        (email) =>
          email && typeof email === 'string' && emailRegex.test(email.trim()),
      );

      if (validEmails.length === 0) {
        throw new Error('No valid email addresses provided');
      }

      // Prepare conversation context
      const context = {
        conversationId: input.conversationId,
      };

      // Send transcript to each valid email address
      const results: Array<{
        email: string;
        success: boolean;
        data: any;
      }> = [];
      const errors: Array<{
        email: string;
        error: string;
      }> = [];

      for (const email of validEmails) {
        try {
          const response = await this.crmService.sendTranscript(
            context,
            email.trim(),
            'send-transcript',
          );

          if (response.success) {
            results.push({
              email: email.trim(),
              success: true,
              data: response.data,
            });
          } else {
            errors.push({
              email: email.trim(),
              error: response.error || 'Unknown error',
            });
          }
        } catch (error) {
          errors.push({
            email: email.trim(),
            error: error.message,
          });
        }
      }

      // Check if any transcripts were sent successfully
      if (results.length === 0) {
        throw new Error(
          `Failed to send transcript to all recipients: ${JSON.stringify(errors)}`,
        );
      }

      // Log results
      this.logger.log('Transcript sending completed', {
        conversationId: input.conversationId,
        successCount: results.length,
        errorCount: errors.length,
        recipients: validEmails,
        nodeId: input.nodeId,
      });

      // Log errors if any
      if (errors.length > 0) {
        this.logger.warn('Some transcript sends failed', {
          conversationId: input.conversationId,
          errors,
        });
      }

      return {
        transcriptSent: true,
        successCount: results.length,
        errorCount: errors.length,
        recipients: validEmails,
        results,
        errors,
        sendTimestamp: new Date().toISOString(),
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_transcript_sent`]: result.transcriptSent,
          [`node_${input.nodeId}_success_count`]: result.successCount,
          [`node_${input.nodeId}_error_count`]: result.errorCount,
          [`node_${input.nodeId}_send_timestamp`]: result.sendTimestamp,
          [`node_${input.nodeId}_recipients`]: result.recipients,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to send transcript', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
