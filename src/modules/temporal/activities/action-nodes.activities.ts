import {
  NodeExecutionResult,
  AddLabelNode,
  AddLabelNodeInput,
  RemoveLabelNode,
  RemoveLabelNodeInput,
  UpdateContactNode,
  UpdateContactNodeInput,
  UpdateCustomAttributeNode,
  UpdateCustomAttributeNodeInput,
  SplitNode,
  SplitNodeInput,
  SetVariableNode,
  SetVariableNodeInput,
  ExitJourneyNode,
  ExitJourneyNodeInput,
  TransferJourneyNode,
  TransferJourneyNodeInput,
  WaitNode,
  WaitNodeInput,
  SendWebhookNode,
  SendWebhookNodeInput,
  ConditionalNode,
  ConditionalNodeInput,
  TriggerNode,
  TriggerNodeInput,
} from './nodes';
import { SendMessageNode, SendMessageNodeInput } from './nodes/evoai/communication/send-message.node';
import { SendCannedResponseNode, SendCannedResponseNodeInput } from './nodes/evoai/communication/send-canned-response.node';
import { SendEmailTeamNode, SendEmailTeamNodeInput } from './nodes/evoai/communication/send-email-team.node';
import { AssignToPipelineNode, AssignToPipelineNodeInput } from './nodes/evoai/pipeline/assign-to-pipeline.node';
import { SendTranscriptNode, SendTranscriptNodeInput } from './nodes/evoai/communication/send-transcript.node';
import { AssignAgentNode, AssignAgentNodeInput } from './nodes/evoai/assignment/assign-agent.node';
import { AssignTeamNode, AssignTeamNodeInput } from './nodes/evoai/assignment/assign-team.node';
import { AssignBotNode, AssignBotNodeInput } from './nodes/evoai/assignment/assign-bot.node';
import { MuteConversationNode, MuteConversationNodeInput } from './nodes/evoai/conversation/mute-conversation.node';
import { ResolveConversationNode, ResolveConversationNodeInput } from './nodes/evoai/conversation/resolve-conversation.node';
import { SnoozeConversationNode, SnoozeConversationNodeInput } from './nodes/evoai/conversation/snooze-conversation.node';
import { ChangePriorityNode, ChangePriorityNodeInput } from './nodes/evoai/conversation/change-priority.node';
import { ScheduledActionNode, ScheduledActionNodeInput } from './nodes/scheduled-action.node';
import { calculateWaitTimes } from '../utils/wait-time.util';

// Re-export interfaces for backward compatibility
export {
  NodeExecutionResult,
  AddLabelNodeInput,
  RemoveLabelNodeInput,
  UpdateContactNodeInput,
  UpdateCustomAttributeNodeInput,
  SplitNodeInput,
  SetVariableNodeInput,
  ExitJourneyNodeInput,
  TransferJourneyNodeInput,
  WaitNodeInput,
  SendWebhookNodeInput,
  ConditionalNodeInput,
  TriggerNodeInput,
  SendMessageNodeInput,
  SendTranscriptNodeInput,
  AssignAgentNodeInput,
  AssignTeamNodeInput,
  AssignBotNodeInput,
  MuteConversationNodeInput,
  ResolveConversationNodeInput,
  SnoozeConversationNodeInput,
  SendCannedResponseNodeInput,
  SendEmailTeamNodeInput,
  AssignToPipelineNodeInput,
  ChangePriorityNodeInput,
  ScheduledActionNodeInput,
};

// Activities interface for action nodes
export interface ActionNodeActivities {
  executeAddLabelNode(input: AddLabelNodeInput): Promise<NodeExecutionResult>;
  executeRemoveLabelNode(
    input: RemoveLabelNodeInput,
  ): Promise<NodeExecutionResult>;
  executeUpdateContactNode(
    input: UpdateContactNodeInput,
  ): Promise<NodeExecutionResult>;
  executeUpdateCustomAttributeNode(
    input: UpdateCustomAttributeNodeInput,
  ): Promise<NodeExecutionResult>;
  executeSplitNode(input: SplitNodeInput): Promise<NodeExecutionResult>;
  executeSetVariableNode(
    input: SetVariableNodeInput,
  ): Promise<NodeExecutionResult>;
  executeExitJourneyNode(
    input: ExitJourneyNodeInput,
  ): Promise<NodeExecutionResult>;
  executeTransferJourneyNode(
    input: TransferJourneyNodeInput,
  ): Promise<NodeExecutionResult>;
  executeWaitNode(input: WaitNodeInput): Promise<NodeExecutionResult>;
  executeSendWebhookNode(
    input: SendWebhookNodeInput,
  ): Promise<NodeExecutionResult>;
  executeConditionalNode(
    input: ConditionalNodeInput,
  ): Promise<NodeExecutionResult>;
  executeTriggerNode(input: TriggerNodeInput): Promise<NodeExecutionResult>;
  executeSendMessageNode(
    input: SendMessageNodeInput,
  ): Promise<NodeExecutionResult>;
  executeSendCannedResponseNode(
    input: SendCannedResponseNodeInput,
  ): Promise<NodeExecutionResult>;
  executeSendEmailTeamNode(
    input: SendEmailTeamNodeInput,
  ): Promise<NodeExecutionResult>;
  executeAssignToPipelineNode(
    input: AssignToPipelineNodeInput,
  ): Promise<NodeExecutionResult>;
  executeSendTranscriptNode(
    input: SendTranscriptNodeInput,
  ): Promise<NodeExecutionResult>;
  executeAssignAgentNode(
    input: AssignAgentNodeInput,
  ): Promise<NodeExecutionResult>;
  executeAssignTeamNode(
    input: AssignTeamNodeInput,
  ): Promise<NodeExecutionResult>;
  executeAssignBotNode(
    input: AssignBotNodeInput,
  ): Promise<NodeExecutionResult>;
  executeMuteConversationNode(
    input: MuteConversationNodeInput,
  ): Promise<NodeExecutionResult>;
  executeResolveConversationNode(
    input: ResolveConversationNodeInput,
  ): Promise<NodeExecutionResult>;
  executeSnoozeConversationNode(
    input: SnoozeConversationNodeInput,
  ): Promise<NodeExecutionResult>;
  executeChangePriorityNode(
    input: ChangePriorityNodeInput,
  ): Promise<NodeExecutionResult>;
  executeScheduledActionNode(
    input: ScheduledActionNodeInput,
  ): Promise<NodeExecutionResult>;
  processWaitCompletion(input: {
    nodeId: string;
    contactId: string;
    sessionId: string;
    nodeData: any;
    waitResult: 'success' | 'timeout' | 'cancelled';
  }): Promise<string | undefined>;
}

// Node instances for modular execution - using lazy initialization to avoid Temporal context issues
let addLabelNode: AddLabelNode;
let removeLabelNode: RemoveLabelNode;
let updateContactNode: UpdateContactNode;
let updateCustomAttributeNode: UpdateCustomAttributeNode;
let splitNode: SplitNode;
let setVariableNode: SetVariableNode;
let exitJourneyNode: ExitJourneyNode;
let transferJourneyNode: TransferJourneyNode;
let sendWebhookNode: SendWebhookNode;
let conditionalNode: ConditionalNode;
let triggerNode: TriggerNode;
let sendMessageNode: SendMessageNode;
let sendCannedResponseNode: SendCannedResponseNode;
let sendEmailTeamNode: SendEmailTeamNode;
let assignToPipelineNode: AssignToPipelineNode;
let sendTranscriptNode: SendTranscriptNode;
let assignAgentNode: AssignAgentNode;
let assignTeamNode: AssignTeamNode;
let assignBotNode: AssignBotNode;
let muteConversationNode: MuteConversationNode;
let resolveConversationNode: ResolveConversationNode;
let snoozeConversationNode: SnoozeConversationNode;
let changePriorityNode: ChangePriorityNode;
let scheduledActionNode: ScheduledActionNode;

// Lazy initialization functions
function getAddLabelNode() {
  if (!addLabelNode) addLabelNode = new AddLabelNode();
  return addLabelNode;
}

function getRemoveLabelNode() {
  if (!removeLabelNode) removeLabelNode = new RemoveLabelNode();
  return removeLabelNode;
}

function getUpdateContactNode() {
  if (!updateContactNode) updateContactNode = new UpdateContactNode();
  return updateContactNode;
}

function getUpdateCustomAttributeNode() {
  if (!updateCustomAttributeNode) updateCustomAttributeNode = new UpdateCustomAttributeNode();
  return updateCustomAttributeNode;
}

function getSplitNode() {
  if (!splitNode) splitNode = new SplitNode();
  return splitNode;
}

function getSetVariableNode() {
  if (!setVariableNode) setVariableNode = new SetVariableNode();
  return setVariableNode;
}

function getExitJourneyNode() {
  if (!exitJourneyNode) exitJourneyNode = new ExitJourneyNode();
  return exitJourneyNode;
}

function getTransferJourneyNode() {
  if (!transferJourneyNode) transferJourneyNode = new TransferJourneyNode();
  return transferJourneyNode;
}

function getSendWebhookNode() {
  if (!sendWebhookNode) sendWebhookNode = new SendWebhookNode();
  return sendWebhookNode;
}

function getConditionalNode() {
  if (!conditionalNode) conditionalNode = new ConditionalNode();
  return conditionalNode;
}

function getTriggerNode() {
  if (!triggerNode) triggerNode = new TriggerNode();
  return triggerNode;
}

function getSendMessageNode() {
  if (!sendMessageNode) sendMessageNode = new SendMessageNode();
  return sendMessageNode;
}

function getSendCannedResponseNode() {
  if (!sendCannedResponseNode)
    sendCannedResponseNode = new SendCannedResponseNode();
  return sendCannedResponseNode;
}

function getSendEmailTeamNode() {
  if (!sendEmailTeamNode) sendEmailTeamNode = new SendEmailTeamNode();
  return sendEmailTeamNode;
}

function getAssignToPipelineNode() {
  if (!assignToPipelineNode)
    assignToPipelineNode = new AssignToPipelineNode();
  return assignToPipelineNode;
}

function getSendTranscriptNode() {
  if (!sendTranscriptNode) sendTranscriptNode = new SendTranscriptNode();
  return sendTranscriptNode;
}

function getAssignAgentNode() {
  if (!assignAgentNode) assignAgentNode = new AssignAgentNode();
  return assignAgentNode;
}

function getAssignTeamNode() {
  if (!assignTeamNode) assignTeamNode = new AssignTeamNode();
  return assignTeamNode;
}

function getAssignBotNode() {
  if (!assignBotNode) assignBotNode = new AssignBotNode();
  return assignBotNode;
}

function getMuteConversationNode() {
  if (!muteConversationNode) muteConversationNode = new MuteConversationNode();
  return muteConversationNode;
}

function getResolveConversationNode() {
  if (!resolveConversationNode) resolveConversationNode = new ResolveConversationNode();
  return resolveConversationNode;
}

function getSnoozeConversationNode() {
  if (!snoozeConversationNode) snoozeConversationNode = new SnoozeConversationNode();
  return snoozeConversationNode;
}

function getChangePriorityNode() {
  if (!changePriorityNode) changePriorityNode = new ChangePriorityNode();
  return changePriorityNode;
}

function getScheduledActionNode() {
  if (!scheduledActionNode) scheduledActionNode = new ScheduledActionNode();
  return scheduledActionNode;
}

// Implementation of action node activities
export const actionNodeActivities: ActionNodeActivities = {
  async executeAddLabelNode(
    input: AddLabelNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getAddLabelNode().execute(input);
  },

  async executeRemoveLabelNode(
    input: RemoveLabelNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getRemoveLabelNode().execute(input);
  },

  async executeUpdateContactNode(
    input: UpdateContactNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getUpdateContactNode().execute(input);
  },

  async executeUpdateCustomAttributeNode(
    input: UpdateCustomAttributeNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getUpdateCustomAttributeNode().execute(input);
  },

  async executeSplitNode(input: SplitNodeInput): Promise<NodeExecutionResult> {
    return await getSplitNode().execute(input);
  },

  async executeSetVariableNode(
    input: SetVariableNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSetVariableNode().execute(input);
  },

  async executeExitJourneyNode(
    input: ExitJourneyNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getExitJourneyNode().execute(input);
  },

  async executeTransferJourneyNode(
    input: TransferJourneyNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getTransferJourneyNode().execute(input);
  },

  async executeWaitNode(input: WaitNodeInput): Promise<NodeExecutionResult> {
    const { log } = await import('@temporalio/activity');
    
    log.info('🚨 DEBUG: Setting up wait node', {
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      waitType: input.nodeData.waitType,
      enableFallback: input.nodeData.enableFallback,
      fallbackTime: input.nodeData.fallbackTime,
      fallbackUnit: input.nodeData.fallbackUnit,
      fullNodeData: JSON.stringify(input.nodeData),
    });

    try {
      // Calculate wait times based on configuration
      const waitTimes = calculateWaitTimes(input.nodeData.waitType, input.nodeData);
      
      log.info('🚨 DEBUG: Wait times calculated', {
        nodeId: input.nodeId,
        waitType: input.nodeData.waitType,
        expectedCompleteAt: waitTimes.expectedCompleteAt?.toISOString(),
        fallbackAt: waitTimes.fallbackAt?.toISOString(),
        fallbackTimeoutMs: waitTimes.fallbackAt 
          ? waitTimes.fallbackAt.getTime() - Date.now() 
          : waitTimes.expectedCompleteAt 
            ? waitTimes.expectedCompleteAt.getTime() - Date.now()
            : undefined,
      });
      
      // Update session status to WAITING in database
      await updateSessionWaitingStatus({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        contactId: input.contactId,
        waitType: input.nodeData.waitType,
        waitConfig: input.nodeData,
        expectedCompleteAt: waitTimes.expectedCompleteAt,
        fallbackAt: waitTimes.fallbackAt,
      });

      // Return wait configuration for workflow to handle timing
      return {
        success: true,
        shouldPause: true, // Signal to workflow to pause execution
        waitId: `${input.sessionId}-${input.nodeId}`,
        executionTime: Date.now(),
        variables: {
          [`node_${input.nodeId}_wait_type`]: input.nodeData.waitType,
          [`node_${input.nodeId}_wait_started`]: new Date().toISOString(),
          [`node_${input.nodeId}_expected_complete`]: waitTimes.expectedCompleteAt?.toISOString(),
          [`node_${input.nodeId}_fallback_at`]: waitTimes.fallbackAt?.toISOString(),
        },
        // Pass timing info to workflow for Temporal timers
        metadata: {
          waitType: input.nodeData.waitType,
          expectedCompleteAt: waitTimes.expectedCompleteAt?.toISOString(),
          fallbackAt: waitTimes.fallbackAt?.toISOString(),
          // Use fallbackAt for 'event' and 'condition' types, expectedCompleteAt for 'time' and 'time_or_condition'
          fallbackTimeoutMs: waitTimes.fallbackAt 
            ? waitTimes.fallbackAt.getTime() - Date.now() 
            : waitTimes.expectedCompleteAt 
              ? waitTimes.expectedCompleteAt.getTime() - Date.now()
              : undefined,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTime: Date.now(),
      };
    }
  },

  async executeSendWebhookNode(
    input: SendWebhookNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSendWebhookNode().execute(input);
  },

  async executeConditionalNode(
    input: ConditionalNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getConditionalNode().execute(input);
  },

  async executeTriggerNode(
    input: TriggerNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getTriggerNode().execute(input);
  },

  async executeSendMessageNode(
    input: SendMessageNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSendMessageNode().execute(input);
  },

  async executeSendCannedResponseNode(
    input: SendCannedResponseNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSendCannedResponseNode().execute(input);
  },

  async executeSendEmailTeamNode(
    input: SendEmailTeamNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSendEmailTeamNode().execute(input);
  },

  async executeAssignToPipelineNode(
    input: AssignToPipelineNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getAssignToPipelineNode().execute(input);
  },

  async executeSendTranscriptNode(
    input: SendTranscriptNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSendTranscriptNode().execute(input);
  },

  async executeAssignAgentNode(
    input: AssignAgentNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getAssignAgentNode().execute(input);
  },

  async executeAssignTeamNode(
    input: AssignTeamNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getAssignTeamNode().execute(input);
  },

  async executeAssignBotNode(
    input: AssignBotNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getAssignBotNode().execute(input);
  },

  async executeMuteConversationNode(
    input: MuteConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getMuteConversationNode().execute(input);
  },

  async executeResolveConversationNode(
    input: ResolveConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getResolveConversationNode().execute(input);
  },

  async executeSnoozeConversationNode(
    input: SnoozeConversationNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getSnoozeConversationNode().execute(input);
  },

  async executeChangePriorityNode(
    input: ChangePriorityNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getChangePriorityNode().execute(input);
  },

  async executeScheduledActionNode(
    input: ScheduledActionNodeInput,
  ): Promise<NodeExecutionResult> {
    return await getScheduledActionNode().execute(input);
  },

  processWaitCompletion(input: {
    nodeId: string;
    contactId: string;
    sessionId: string;
    nodeData: any;
    waitResult: 'success' | 'timeout' | 'cancelled';
  }): Promise<string | undefined> {
    // Use the static method from WaitNode
    const result = WaitNode.processWaitCompletion(
      {
        nodeId: input.nodeId,
        contactId: input.contactId,
        sessionId: input.sessionId,
        nodeData: input.nodeData,
      },
      input.waitResult,
    );
    // Convert null to undefined
    return Promise.resolve(result || undefined);
  },
};

// time conversion and wait time helpers moved to ../utils/wait-time.util

/**
 * Update session waiting status in database
 */
async function updateSessionWaitingStatus(params: {
  sessionId: string;
  nodeId: string;
  contactId: string;
  waitType: string;
  waitConfig: any;
  expectedCompleteAt?: Date;
  fallbackAt?: Date;
}): Promise<void> {
  try {
    // Direct TypeORM approach without NestJS context
    const { AppDataSource } = await import('../../../database/ormconfig');
    const { JourneySession, JourneySessionStatus } = await import(
      '../../journeys/entities/journey-session.entity'
    );

    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }

    const sessionRepository = AppDataSource.getRepository(JourneySession);

    // Update session with waiting status
    await sessionRepository.update(
      { id: params.sessionId },
      {
        status: JourneySessionStatus.WAITING,
        currentNodeId: params.nodeId,
        waitingFor: {
          nodeId: params.nodeId,
          waitType: params.waitType as 'time' | 'event' | 'condition' | 'time_or_condition',
          conditions: params.waitConfig,
          expectedCompleteAt: params.expectedCompleteAt,
          fallbackAt: params.fallbackAt,
        },
        updatedAt: new Date(),
      },
    );

    // Also update cache if available
    try {
      const { journeyExecutionActivities } = await import('./journey-execution.activities');
      
      // Get the existing session from cache first to preserve all fields including workflowId
      const existingSession = await journeyExecutionActivities.getSessionFromCache(
        params.sessionId,
      );
      
      // Create the updated session object for cache update, preserving existing fields
      const updatedSession = {
        ...existingSession, // Preserve all existing fields including workflowId
        id: params.sessionId,
        contactId: params.contactId,
        status: JourneySessionStatus.WAITING,
        currentNodeId: params.nodeId,
        waitingFor: {
          nodeId: params.nodeId,
          waitType: params.waitType as 'time' | 'event' | 'condition' | 'time_or_condition',
          conditions: params.waitConfig,
          expectedCompleteAt: params.expectedCompleteAt,
          fallbackAt: params.fallbackAt,
        },
        updatedAt: new Date(),
        lastCached: new Date(),
      };
      await journeyExecutionActivities.updateSessionInCache(updatedSession);
    } catch (error) {
      // Cache update is optional, don't fail if it doesn't work
      console.warn('Failed to update session cache:', error);
    }
  } catch (error: any) {
    throw new Error(`Failed to update session waiting status: ${error.message}`);
  }
}
