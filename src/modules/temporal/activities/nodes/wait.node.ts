import { BaseNode, NodeExecutionResult } from './base.node';

export interface WaitNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    waitType: 'time' | 'event' | 'condition' | 'time_or_condition';

    // Para tipo time
    duration?: number;
    timeUnit?: 'minutes' | 'hours' | 'days';

    // Para tipo event
    eventType?: string;
    eventTemplate?: string;
    eventProperties?: Array<{
      path: string;
      operator: { type: string; value?: any };
    }>;
    segmentId?: string;
    segmentAction?: 'entered' | 'exited';
    labelId?: string;
    labelAction?: 'applied' | 'removed';
    attributeName?: string;
    attributeOperator?: string;
    attributeValue?: string;
    webhookUrl?: string;
    webhookHeaders?: Array<{ key: string; value: string }>;

    // Variable mappings from events (similar to trigger)
    variableMappings?: Array<{
      id: string;
      sourcePath: string;
      variableName: string;
      transform?: 'none' | 'uppercase' | 'lowercase' | 'date' | 'number';
    }>;

    // Para tipo condition
    conditionType?: string;
    conditionField?: string;
    conditionOperator?: string;
    conditionValue?: any;
    contactFields?: Array<{ field: string; operator: string; value: string }>;

    // Para timeout/fallback
    hasTimeout?: boolean;
    maxWaitTime?: number;
    maxWaitUnit?: 'minutes' | 'hours' | 'days';
    enableFallback?: boolean;
    fallbackTime?: number;
    fallbackUnit?: 'minutes' | 'hours' | 'days';

    // Next nodes based on outcome
    nextNodeId?: string; // Default next node
    successNodeId?: string; // For multi-output: success/condition met
    otherwiseNodeId?: string; // For multi-output: timeout/fallback
  };
}

export class WaitNode extends BaseNode {
  constructor() {
    super('Wait');
  }

  async execute(input: WaitNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Use the wait activities instead of creating app context
      const { waitActivities } = await import('../wait.activities');

      // Register the wait
      const waitRegistration = await waitActivities.registerWait({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        contactId: input.contactId,
        waitType: input.nodeData.waitType,
        waitConfig: input.nodeData,
      });

      this.logger.log('Wait node configured', {
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        waitType: input.nodeData.waitType,
        waitId: waitRegistration.id,
      });

      return {
        waitId: waitRegistration.id,
        waitType: input.nodeData.waitType,
        expectedCompleteAt: waitRegistration.expectedCompleteAt,
        fallbackAt: waitRegistration.fallbackAt,
      };
    })
      .then(({ result, executionTime }) => {
        // Return special result indicating workflow should pause
        return {
          success: true,
          shouldPause: true, // Signal to workflow to pause execution
          waitId: result.waitId,
          executionTime,
          variables: {
            [`node_${input.nodeId}_wait_type`]: result.waitType,
            [`node_${input.nodeId}_wait_started`]: new Date().toISOString(),
            [`node_${input.nodeId}_expected_complete`]:
              result.expectedCompleteAt?.toISOString(),
            [`node_${input.nodeId}_fallback_at`]:
              result.fallbackAt?.toISOString(),
          },
        };
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  /**
   * Process wait completion (called by signal handler)
   */
  static processWaitCompletion(
    input: WaitNodeInput,
    result: 'success' | 'timeout' | 'cancelled',
  ): string | null {
    const { nodeData } = input;
    const hasMultipleOutputs =
      nodeData.enableFallback || nodeData.waitType === 'time_or_condition';

    if (!hasMultipleOutputs) {
      // Single output - always go to default next node
      return nodeData.nextNodeId || null;
    }

    // Multiple outputs - determine path based on result
    if (result === 'success') {
      // For success: use successNodeId or fallback to nextNodeId
      return nodeData.successNodeId || nodeData.nextNodeId || null;
    } else {
      // For timeout/cancelled: use otherwiseNodeId (fallback path)
      return nodeData.otherwiseNodeId || null;
    }
  }
}
