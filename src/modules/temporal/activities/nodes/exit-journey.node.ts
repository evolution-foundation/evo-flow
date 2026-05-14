import { BaseNode, NodeExecutionResult } from './base.node';

export interface ExitJourneyNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    exitReason?: string;
    exitMessage?: string;
    nextNodeId?: string; // Should be null for exit nodes
  };
}

export class ExitJourneyNode extends BaseNode {
  constructor() {
    super('exit-journey-node');
  }

  async execute(input: ExitJourneyNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const exitReason = input.nodeData.exitReason || 'completed';
      const exitMessage = input.nodeData.exitMessage || 'Journey completed successfully';

      console.log('🔍 DEBUG: Exit Journey Node executing', {
        nodeId: input.nodeId,
        contactId: input.contactId,
        sessionId: input.sessionId,
        exitReason,
        exitMessage,
      });

      return {
        exitReason,
        exitMessage,
        completed: true,
        timestamp: new Date().toISOString(),
      };
    })
      .then(({ result, executionTime }) => {
        const successResult = this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_exit_reason`]: result.exitReason,
          [`node_${input.nodeId}_exit_message`]: result.exitMessage,
          [`journey_exit_reason`]: result.exitReason,
          [`journey_exit_message`]: result.exitMessage,
          [`journey_exited_at`]: result.timestamp,
          [`journey_completed`]: true,
        });

        console.log('🔍 DEBUG: Exit Journey Node completed successfully', {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
          success: successResult.success,
          nextNodeId: successResult.nextNodeId,
          executionTime,
        });

        return successResult;
      })
      .catch((error) => {
        const executionTime = Date.now();
        console.error('🔍 DEBUG: Exit Journey Node failed', {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
          error: error.message,
          stack: error.stack,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
