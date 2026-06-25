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

  // Source handles drawn by the FE Wait node (WaitNode.tsx) for multi-output waits.
  static readonly SUCCESS_HANDLE = 'wait-success';
  static readonly OTHERWISE_HANDLE = 'wait-otherwise';

  /**
   * Whether the Wait node exposes the two branch outputs (success vs
   * timeout/fallback) in the editor. Mirrors `needsMultipleOutputs` in the FE.
   */
  static hasMultipleOutputs(nodeData: WaitNodeInput['nodeData']): boolean {
    return Boolean(
      nodeData?.enableFallback || nodeData?.waitType === 'time_or_condition',
    );
  }

  /**
   * Resolve which outgoing edge handle the workflow should follow once the wait
   * completes. For multi-output waits this maps the result to the FE handles
   * (`wait-success` / `wait-otherwise`) so the workflow can match the edge by
   * `sourceHandle` — the same contract used by conditional/split nodes.
   * Single-output waits return `null` (workflow takes the only outgoing edge).
   */
  static resolveWaitHandle(
    input: WaitNodeInput,
    result: 'success' | 'timeout' | 'cancelled',
  ): string | null {
    if (!WaitNode.hasMultipleOutputs(input.nodeData)) {
      // Single output - workflow follows the single outgoing edge.
      return null;
    }

    return result === 'success'
      ? WaitNode.SUCCESS_HANDLE
      : WaitNode.OTHERWISE_HANDLE;
  }

  /**
   * Process wait completion (called by signal handler).
   *
   * Legacy id-based routing kept for journeys that explicitly persist
   * `successNodeId` / `otherwiseNodeId` / `nextNodeId` in node-data. The FE
   * never writes these fields, so handle-based routing via `resolveWaitHandle`
   * is the primary mechanism; this returns `null` in that case and the workflow
   * falls back to matching the outgoing edge by `sourceHandle`.
   */
  static processWaitCompletion(
    input: WaitNodeInput,
    result: 'success' | 'timeout' | 'cancelled',
  ): string | null {
    const { nodeData } = input;

    if (!WaitNode.hasMultipleOutputs(nodeData)) {
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
