import { BaseNode, NodeExecutionResult } from './base.node';
import { Repository } from 'typeorm';
import type { ScheduledJourneyAction } from '../../../journeys/entities/scheduled-journey-action.entity';
import { ScheduledActionStatus } from '../../../journeys/entities/scheduled-journey-action.entity';
import { CrmClientService } from '../../../../shared/crm-client/crm-client.service';

export interface ScheduledActionNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  journeyId: string;
  nodeData: {
    delayDuration: number;
    delayUnit: 'minutes' | 'hours' | 'days' | 'weeks';
    actionType: string;
    actionConfig: Record<string, any>;
    retryPolicy?: {
      maxRetries?: number;
      backoffMultiplier?: number;
    };
    createScheduledAction?: boolean;
    notifyUserId?: string;
  };
}

export class ScheduledActionNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('scheduled-action-node');
    this.crmService = new CrmClientService();
  }

  async execute(input: ScheduledActionNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const { nodeData, contactId, sessionId, journeyId } = input;

      // Calculate scheduled time
      const now = new Date();
      const scheduledFor = this.calculateScheduledTime(
        nodeData.delayDuration,
        nodeData.delayUnit,
      );
      
      console.log('🔍 DEBUG: Time calculation', {
        now: now.toISOString(),
        delayDuration: nodeData.delayDuration,
        delayUnit: nodeData.delayUnit,
        scheduledFor: scheduledFor.toISOString(),
        calculatedDelayMinutes: (scheduledFor.getTime() - now.getTime()) / 1000 / 60,
      });

      // Initialize database
      const dataSource = await this.initializeDatabase();
      const { ScheduledJourneyAction } = await import(
        '../../../journeys/entities/scheduled-journey-action.entity'
      );

      const scheduledActionRepository: Repository<ScheduledJourneyAction> =
        dataSource.getRepository('ScheduledJourneyAction');

      // Create scheduled action record
      const scheduledAction = scheduledActionRepository.create({
        journeyId,
        sessionId,
        contactId,
        nodeId: input.nodeId,
        actionConfig: {
          delayDuration: nodeData.delayDuration,
          delayUnit: nodeData.delayUnit,
          actionType: nodeData.actionType,
          actionConfig: nodeData.actionConfig,
          retryPolicy: nodeData.retryPolicy || {
            maxRetries: 3,
            backoffMultiplier: 1.5,
          },
        },
        scheduledFor,
        status: ScheduledActionStatus.PENDING,
      });

      await scheduledActionRepository.save(scheduledAction);

      console.log('🔍 DEBUG: Scheduled Action Node created', {
        nodeId: input.nodeId,
        scheduledActionId: scheduledAction.id,
        scheduledFor,
        contactId,
      });

      // Debug: Log the nodeData to see what we're getting
      console.log('🔍 DEBUG: NodeData before createScheduledAction check', {
        createScheduledAction: nodeData.createScheduledAction,
        actionType: nodeData.actionType,
        actionConfig: nodeData.actionConfig,
        notifyUserId: nodeData.notifyUserId,
      });

      // If configured, create a scheduled action in CRM
      // Default to true if not explicitly set to false (for backward compatibility)
      if (nodeData.createScheduledAction !== false) {
        console.log('🔍 DEBUG: createScheduledAction is TRUE, attempting to create scheduled action in CRM');
        try {
          await this.createScheduledActionInCRM(contactId,
            sessionId,
            nodeData,
            scheduledFor,
          );

          console.log('🔍 DEBUG: Scheduled action created in CRM', {
            contactId,
          });
        } catch (error) {
          const errorMessage = `CRM API Error: ${(error as Error).message}`;
          console.error('🔍 DEBUG: Failed to create scheduled action in CRM', {
            error: (error as Error).message,
            contactId,
          });

          // Log error to database so we can see what happened
          await scheduledActionRepository.update(scheduledAction.id, {
            errorMessage,
            status: ScheduledActionStatus.FAILED,
          });
          // Don't fail the node, just log the error
        }
      }

      return {
        scheduledActionId: scheduledAction.id,
        scheduledFor: scheduledFor.toISOString(),
        delayMinutes: this.getDelayInMinutes(
          nodeData.delayDuration,
          nodeData.delayUnit,
        ),
      };
    })
      .then(({ result, executionTime }) => {
        const successResult = this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_scheduled_action_id`]: result.scheduledActionId,
          [`node_${input.nodeId}_scheduled_for`]:
            result.scheduledFor,
          [`node_${input.nodeId}_delay_minutes`]: result.delayMinutes,
          // Signal that this node should pause the workflow
          shouldPause: true,
          waitId: result.scheduledActionId,
        });

        console.log('🔍 DEBUG: Scheduled Action Node completed', {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
          scheduledActionId: result.scheduledActionId,
          executionTime,
        });

        return successResult;
      })
      .catch((error) => {
        const executionTime = Date.now();
        console.error('🔍 DEBUG: Scheduled Action Node failed', {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
        return this.createErrorResult(error as Error, executionTime);
      });
  }

  private calculateScheduledTime(
    duration: number,
    unit: 'minutes' | 'hours' | 'days' | 'weeks',
  ): Date {
    const now = new Date();
    const scheduledTime = new Date(now);

    // Calculate delay in milliseconds to avoid timezone/date boundary issues
    let delayMs = 0;
    switch (unit) {
      case 'minutes':
        delayMs = duration * 60 * 1000;
        break;
      case 'hours':
        delayMs = duration * 60 * 60 * 1000;
        break;
      case 'days':
        delayMs = duration * 24 * 60 * 60 * 1000;
        break;
      case 'weeks':
        delayMs = duration * 7 * 24 * 60 * 60 * 1000;
        break;
    }

    scheduledTime.setTime(now.getTime() + delayMs);
    return scheduledTime;
  }

  private getDelayInMinutes(
    duration: number,
    unit: 'minutes' | 'hours' | 'days' | 'weeks',
  ): number {
    switch (unit) {
      case 'minutes':
        return duration;
      case 'hours':
        return duration * 60;
      case 'days':
        return duration * 24 * 60;
      case 'weeks':
        return duration * 7 * 24 * 60;
      default:
        return 0;
    }
  }

  private async createScheduledActionInCRM(
    contactId: string,
    sessionId: string,
    nodeData: ScheduledActionNodeInput['nodeData'],
    scheduledFor: Date,
  ): Promise<void> {
    this.logger.log('Creating scheduled action in CRM', {
      contactId,
      sessionId,
      actionType: nodeData.actionType,
      scheduledFor: scheduledFor.toISOString(),
    });

    const response = await this.crmService.createScheduledAction(contactId,
      nodeData.actionType,
      scheduledFor,
      nodeData.actionConfig,
      {
        journeySessionId: sessionId,
        notifyUserId: nodeData.notifyUserId,
        maxRetries: nodeData.retryPolicy?.maxRetries,
      },
    );

    if (!response.success) {
      throw new Error(
        `Failed to create scheduled action in CRM: ${response.error || 'Unknown error'}`,
      );
    }

    if (!response.data?.id) {
      throw new Error('Failed to create scheduled action in CRM - no id in response');
    }

    this.logger.log('Scheduled action created in CRM successfully', {
      scheduledActionId: response.data.id,
      contactId,
    });
  }
}
