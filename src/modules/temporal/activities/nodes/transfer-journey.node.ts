import { BaseNode, NodeExecutionResult } from './base.node';
import { getAppContext } from '../../../../shared/app-context.holder';
import { TEMPORAL_TASK_QUEUES } from '../../temporal-task-queues.constants';

export interface TransferJourneyNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    targetJourneyId: string;
    targetJourneyName?: string;
    transferVariables?: boolean; // Whether to pass current variables to new journey
    variablesToTransfer?: string[]; // Specific variables to transfer
    nextNodeId?: string; // Should be null for transfer nodes
  };
}

export class TransferJourneyNode extends BaseNode {
  private journeysService: any = null;

  constructor() {
    super('TransferJourney');
  }

  private async getServices() {
    const appContext = getAppContext();

    if (!this.journeysService) {
      const { JourneysService } = await import('../../../journeys/journeys.service');
      this.journeysService = appContext.get(JourneysService);
    }

    return {
      journeysService: this.journeysService
    };
  }

  async execute(input: TransferJourneyNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      if (!input.nodeData.targetJourneyId) {
        throw new Error('Target journey ID is required for transfer node');
      }

      // Import required services
      const { Client, Connection } = await import('@temporalio/client');
      const { JourneyExecutionWorkflow } = await import(
        '../../workflows/journey-execution.workflow'
      );
      const { randomUUID } = await import('crypto');

      // Get services using lazy initialization
      const { journeysService } = await this.getServices();

      try {

        const targetJourney = await journeysService.findOne(
          input.nodeData.targetJourneyId,
        );

        if (!targetJourney) {
          throw new Error(
            `Target journey ${input.nodeData.targetJourneyId} not found`,
          );
        }

        if (!targetJourney.isActive) {
          throw new Error(
            `Target journey ${input.nodeData.targetJourneyId} is not active`,
          );
        }

        // Start the new journey workflow
        const connection = await Connection.connect({
          address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
        });

        const client = new Client({
          connection,
          namespace: process.env.TEMPORAL_NAMESPACE || 'default',
        });

        // Generate unique workflow ID for the new journey
        const newSessionId = randomUUID();
        const workflowId = `journey-${targetJourney.id}-contact-${input.contactId}-${Date.now()}`;

        // Prepare workflow arguments
        const workflowArgs = {
          sessionId: newSessionId,
          journeyId: targetJourney.id,
          contactId: input.contactId,
          transferredFrom: {
            journeyId: input.sessionId,
            nodeId: input.nodeId,
            timestamp: new Date().toISOString(),
          },
          // TODO: Transfer variables if configured
          initialVariables: {},
        };

        // Start the new journey workflow
        const handle = await client.workflow.start(JourneyExecutionWorkflow, {
          taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
          workflowId,
          args: [workflowArgs],
          workflowExecutionTimeout: '24h',
          workflowTaskTimeout: '1m',
        });

        this.logger.log('Contact transferred to new journey', {
          fromJourney: input.sessionId,
          toJourney: targetJourney.id,
          toJourneyName: targetJourney.name,
          contactId: input.contactId,
          newSessionId,
          workflowId,
          runId: handle.firstExecutionRunId,
        });

        return {
          targetJourneyId: targetJourney.id,
          targetJourneyName: targetJourney.name,
          newSessionId,
          workflowId,
          transferredAt: new Date().toISOString(),
        };
      } catch (error) {
        this.logger.error('Failed to transfer journey', {
          nodeId: input.nodeId,
          targetJourneyId: input.nodeData.targetJourneyId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })
      .then(({ result, executionTime }) => {
        return {
          success: true,
          nextNodeId: undefined, // No next node in current journey, contact transferred
          executionTime,
          variables: {
            [`node_${input.nodeId}_executed`]: true,
            [`node_${input.nodeId}_execution_time`]: executionTime,
            [`node_${input.nodeId}_timestamp`]: new Date().toISOString(),
            [`journey_transferred_to`]: result.targetJourneyId,
            [`journey_transferred_to_name`]: result.targetJourneyName,
            [`journey_transferred_at`]: result.transferredAt,
            [`journey_new_session_id`]: result.newSessionId,
          },
        };
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }
}
