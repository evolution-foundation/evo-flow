import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  sleep,
  log,
  workflowInfo,
} from '@temporalio/workflow';
import type { JourneyExecutionActivities } from '../activities/journey-execution.activities';
import type { ActionNodeActivities } from '../activities/action-nodes.activities';
import type { JourneyTrackingActivities } from '../activities/journey-tracking.activities';
import type { JourneyTrackingContext } from '../services/journey-tracking.service';
import type { WaitActivities } from '../activities/wait.activities';
import { resolveInitialWorkflowStatus } from './initial-workflow-status.util';

// Interfaces for workflow input and state
export interface JourneyExecutionInput {
  sessionId: string;
  journeyId: string;
  contactId: string;
  triggerEvent?: {
    messageId: string;
    eventName: string;
    eventType: string;
    properties: Record<string, any>;
    // identify-DTO payload (custom attribute, label) rides in traits (EVO-1839).
    traits?: Record<string, any>;
    timestamp: string;
  };
}

export interface JourneyExecutionState {
  currentNodeId?: string;
  variables: Record<string, any>;
  metadata: Record<string, any>;
  completedNodes: string[];
  status: 'running' | 'completed' | 'failed' | 'paused';
}

// Wait completion signal interface
export interface WaitCompletedSignal {
  nodeId: string;
  result: 'success' | 'timeout' | 'cancelled';
  completedAt: string;
  metadata?: Record<string, any>;
}

// Signals for workflow control
export const pauseJourneySignal = defineSignal<[]>('pauseJourney');
export const resumeJourneySignal = defineSignal<[]>('resumeJourney');
export const cancelJourneySignal = defineSignal<[]>('cancelJourney');
export const updateVariablesSignal =
  defineSignal<[Record<string, any>]>('updateVariables');
export const waitCompletedSignal =
  defineSignal<[WaitCompletedSignal]>('waitCompleted');

// Queries for workflow state
export const getJourneyStatusQuery =
  defineQuery<JourneyExecutionState>('getJourneyStatus');

// Proxy activities with aggressive timeout configurations for low latency
const activities = proxyActivities<JourneyExecutionActivities>({
  startToCloseTimeout: '30 seconds', // Reduce from 5 minutes
  scheduleToCloseTimeout: '1 minute', // Add schedule timeout
  retry: {
    initialInterval: '200ms', // Faster initial retry
    maximumInterval: '5s', // Reduce max interval
    backoffCoefficient: 1.5, // Gentler backoff
    maximumAttempts: 2, // Fewer retries for speed
  },
});

// Proxy action node activities with faster timeouts
const actionNodeActivities = proxyActivities<ActionNodeActivities>({
  startToCloseTimeout: '30 seconds', // Reduce from 2 minutes
  scheduleToCloseTimeout: '45 seconds',
  retry: {
    initialInterval: '100ms', // Very fast initial retry
    maximumInterval: '3s', // Reduce max interval
    backoffCoefficient: 1.5,
    maximumAttempts: 2, // Fewer retries for speed
  },
});

// Proxy tracking activities with minimal timeouts
const trackingActivities = proxyActivities<JourneyTrackingActivities>({
  startToCloseTimeout: '10 seconds', // Very aggressive timeout
  scheduleToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '50ms', // Very fast retry
    maximumInterval: '2s',
    backoffCoefficient: 1.2,
    maximumAttempts: 1, // No retries for tracking - fail fast
  },
});

// Proxy wait activities for DB consistency on wait completion
const waitActivitiesProxy = proxyActivities<WaitActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    maximumInterval: '10s',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export async function JourneyExecutionWorkflow(
  input: JourneyExecutionInput,
): Promise<JourneyExecutionState> {
  // 🚀 PERFORMANCE: Try to load existing session state from cache/database first
  let existingSession: any;
  try {
    log.info('🔍 DEBUG: Workflow trying to load existing session from cache', {
      sessionId: input.sessionId,
    });

    existingSession = await activities.getSessionFromCache(
      input.sessionId,
    );

    log.info('🔍 DEBUG: Workflow cache lookup result', {
      sessionId: input.sessionId,
      found: !!existingSession,
      hasVariables: !!existingSession?.variables,
      currentNodeId: existingSession?.currentNodeId,
    });
  } catch (error) {
    log.warn('Failed to load existing session state, starting fresh', {
      sessionId: input.sessionId,
      error: error.message,
    });
  }

  // Initialize state from existing session or create new
  const state: JourneyExecutionState = existingSession
    ? {
        currentNodeId: existingSession.currentNodeId,
        variables: existingSession.variables || {},
        metadata: {
          ...existingSession.metadata,
          triggerEvent: input.triggerEvent, // Always use current trigger
        },
        completedNodes: existingSession.completedNodes || [],
        // Session-store statuses ('active'/'waiting') are a different
        // vocabulary from the workflow loop's ('running'/'paused') — copying
        // them verbatim kept the loop from ever running (EVO-1690).
        status: resolveInitialWorkflowStatus(existingSession.status),
      }
    : {
        currentNodeId: undefined,
        variables: {},
        metadata: {
          startedAt: new Date().toISOString(),
          triggerEvent: input.triggerEvent,
        },
        completedNodes: [],
        status: 'running',
      };

  // Create tracking context
  const trackingContext: JourneyTrackingContext = {
    sessionId: input.sessionId,
    journeyId: input.journeyId,
    contactId: input.contactId,
  };

  let isPaused = false;
  let isWaiting = false;
  const waitCompletions = new Map<string, WaitCompletedSignal>();

  // Set up signal handlers
  setHandler(pauseJourneySignal, () => {
    // log.info('Journey paused by signal', { sessionId: input.sessionId });
    isPaused = true;
    state.status = 'paused';
  });

  setHandler(resumeJourneySignal, () => {
    // log.info('Journey resumed by signal', { sessionId: input.sessionId });
    isPaused = false;
    state.status = 'running';
  });

  setHandler(cancelJourneySignal, () => {
    // log.info('Journey cancelled by signal', { sessionId: input.sessionId });
    state.status = 'failed';
    state.metadata.cancelledAt = new Date().toISOString();
  });

  setHandler(updateVariablesSignal, (variables: Record<string, any>) => {
    // log.info('Journey variables updated by signal', {
    //   sessionId: input.sessionId,
    //   variables,
    // });
    state.variables = { ...state.variables, ...variables };
  });

  setHandler(waitCompletedSignal, (signal: WaitCompletedSignal) => {
    // log.info('🚨 DEBUG: Wait completed signal received', {
    //   sessionId: input.sessionId,
    //   nodeId: signal.nodeId,
    //   result: signal.result,
    //   completedAt: signal.completedAt,
    //   metadata: signal.metadata,
    //   waitCompletionsSizeBefore: waitCompletions.size,
    //   currentState: state.status,
    //   isCurrentlyWaiting: isWaiting,
    // });

    waitCompletions.set(signal.nodeId, signal);
    isWaiting = false;

    // log.info('🚨 DEBUG: Wait completions updated', {
    //   sessionId: input.sessionId,
    //   waitCompletionsSizeAfter: waitCompletions.size,
    //   hasNodeInCompletions: waitCompletions.has(signal.nodeId),
    // });
  });

  // Set up query handler
  setHandler(getJourneyStatusQuery, () => state);

  try {
    log.info('Starting journey execution workflow', {
      sessionId: input.sessionId,
      journeyId: input.journeyId,
      contactId: input.contactId,
    });

    // Get workflow info to access workflowId
    const info = workflowInfo();
    trackingContext.workflowId = info.workflowId;

    // Initialize session in database with workflowId 
    // Always ensure session is properly initialized, even if found in cache
    if (!existingSession) {
      log.info(
        '🔍 DEBUG: No existing session found, initializing new session',
        {
          sessionId: input.sessionId,
        },
      );

      await activities.initializeJourneySession({
        sessionId: input.sessionId,
        journeyId: input.journeyId,
        contactId: input.contactId,
        triggerEvent: input.triggerEvent,
        workflowId: info.workflowId,
        workflowRunId: info.runId, // EVO-1859: persist run id via the authoritative create-path
      });
    } else {
      log.info(
        '🔍 DEBUG: Existing session found in cache, ensuring it\'s properly initialized',
        {
          sessionId: input.sessionId,
          existingVariables: Object.keys(existingSession.variables || {}),
          hasWorkflowId: !!existingSession.workflowId,
        },
      );

      // Ensure the existing session has the current workflowId 
      // This handles cases where workflow restarts or session was incomplete
      if (!existingSession.workflowId || existingSession.workflowId !== info.workflowId) {
        log.info('🔍 DEBUG: Updating existing session with current workflowId', {
          sessionId: input.sessionId,
          oldWorkflowId: existingSession.workflowId,
          newWorkflowId: info.workflowId,
        });

        // Re-initialize to ensure session is complete with current workflow context
        await activities.initializeJourneySession({
          sessionId: input.sessionId,
          journeyId: input.journeyId,
          contactId: input.contactId,
          triggerEvent: input.triggerEvent,
          workflowId: info.workflowId,
          workflowRunId: info.runId, // EVO-1859: persist run id via the authoritative create-path
        });
      }
    }


    // Track journey started
    await trackingActivities.trackJourneyStarted(
      trackingContext,
      input.triggerEvent,
    );

    // Load journey flow data
    const journey = await activities.loadJourneyData({
      journeyId: input.journeyId,
    });

    // Initialize variables with journey defaults
    if (journey.variables && Array.isArray(journey.variables)) {
      const defaultVariables: Record<string, any> = {};
      for (const variable of journey.variables) {
        if (
          variable.defaultValue !== undefined &&
          variable.defaultValue !== ''
        ) {
          defaultVariables[variable.name] = variable.defaultValue;
        }
      }

      if (Object.keys(defaultVariables).length > 0) {
        state.variables = { ...state.variables, ...defaultVariables };

        // Update session with default variables
        await activities.updateJourneySession({
          sessionId: input.sessionId,
          updates: {
            variables: state.variables,
          },
        });

        // log.info('Journey default variables initialized', {
        //   sessionId: input.sessionId,
        //   variables: defaultVariables,
        // });
      }
    }

    // log.info('Journey data loaded', {
    //   sessionId: input.sessionId,
    //   nodesCount: journey.flowData?.nodes?.length || 0,
    //   variablesCount: journey.variables?.length || 0,
    // });

    // Find entry point (trigger node)
    const entryNode = await activities.findEntryNode({
      journeyData: journey,
      triggerEvent: input.triggerEvent,
    });

    if (!entryNode) {
      throw new Error('No valid entry node found for journey');
    }

    state.currentNodeId = entryNode.id;
    let currentNode: { id: string; type: string; data: any } | null = entryNode;

    // Update session with current node
    await activities.updateJourneySession({
      sessionId: input.sessionId,
      updates: {
        currentNodeId: state.currentNodeId,
        status: 'active',
      },
    });

    // Main execution loop - for now, just basic structure
    while (currentNode && state.status === 'running') {
      // Wait if paused
      if (isPaused) {
        // log.info('Journey execution paused, waiting for resume signal', {
        //   sessionId: input.sessionId,
        //   currentNodeId: currentNode.id,
        // });

        await condition(() => !isPaused);

        // log.info('Journey execution resumed', {
        //   sessionId: input.sessionId,
        //   currentNodeId: currentNode.id,
        // });
      }

      // Check for termination (status can change via signals)
      if (state.status !== 'running') {
        log.info('Journey execution terminated', {
          sessionId: input.sessionId,
          currentNodeId: currentNode.id,
          status: state.status,
        });
        break;
      }

      // log.info('Processing journey node', {
      //   sessionId: input.sessionId,
      //   nodeId: currentNode.id,
      //   nodeType: currentNode.type,
      //   nodeData: JSON.stringify(currentNode.data).substring(0, 200) + '...',
      // });

      // Process node based on its type
      let nodeResult: any = { success: true, nextNodeId: undefined };
      let nextNodeId: string | undefined;

      try {
        // log.info('About to execute node', {
        //   sessionId: input.sessionId,
        //   nodeId: currentNode.id,
        //   nodeType: currentNode.type,
        //   nodeData: JSON.stringify(currentNode.data, null, 2),
        //   hasNextNodeIdInData: !!currentNode.data?.nextNodeId,
        //   nextNodeIdFromData: currentNode.data?.nextNodeId,
        // });
        // Log node started - run in parallel for speed
        await Promise.all([
          activities.logNodeExecution({
            sessionId: input.sessionId,
            nodeId: currentNode.id,
            nodeType: currentNode.type,
            status: 'started',
          }),
          // Track node execution started in parallel
          trackingActivities.trackNodeExecution(trackingContext, {
            nodeId: currentNode.id,
            nodeType: currentNode.type,
            status: 'started',
            startTime: new Date(),
          }),
        ]);

        switch (currentNode.type) {
          case 'wait':
          case 'wait-node': // Support both naming conventions
            nodeResult = await actionNodeActivities.executeWaitNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });

            // log.info('🚨 DEBUG: Wait node result received', {
            //   sessionId: input.sessionId,
            //   nodeId: currentNode.id,
            //   success: nodeResult.success,
            //   shouldPause: nodeResult.shouldPause,
            //   hasMetadata: !!nodeResult.metadata,
            //   fallbackTimeoutMs: nodeResult.metadata?.fallbackTimeoutMs,
            //   fullResult: JSON.stringify(nodeResult),
            // });

            // If node indicates we should pause (wait), handle it
            if (nodeResult.shouldPause) {
              isWaiting = true;

              // Clear any stale completion signal for this node before starting a new wait
              if (waitCompletions.has(currentNode.id)) {
                waitCompletions.delete(currentNode.id);
              }

              // log.info('Journey paused for wait node', {
              //   sessionId: input.sessionId,
              //   nodeId: currentNode.id,
              //   waitType: currentNode.data?.waitType,
              //   fallbackTimeoutMs: nodeResult.metadata?.fallbackTimeoutMs,
              // });

              // Wait for completion signal OR timeout using Temporal native timers
              if (!currentNode) {
                throw new Error('Current node is null during wait processing');
              }

              let waitResult: WaitCompletedSignal;

              // Pure time wait: use Temporal sleep instead of race
              if (nodeResult.metadata?.waitType === 'time') {
                const ms = nodeResult.metadata?.fallbackTimeoutMs || 0;
                if (ms > 0) {
                  await sleep(ms);
                }
                waitResult = {
                  nodeId: currentNode?.id || '',
                  result: 'success',
                  completedAt: new Date().toISOString(),
                  metadata: { triggeredBy: 'temporal_sleep' },
                };
              } else if (
                nodeResult.metadata?.fallbackTimeoutMs &&
                nodeResult.metadata.fallbackTimeoutMs > 0
              ) {
                // log.info('🚨 DEBUG: Starting race condition with timeout', {
                //   sessionId: input.sessionId,
                //   nodeId: currentNode.id,
                //   timeoutMs: nodeResult.metadata.fallbackTimeoutMs,
                // });

                // Race condition: wait for signal OR timeout
                // log.info('🚨 DEBUG: About to start condition() with timeout', {
                //   sessionId: input.sessionId,
                //   nodeId: currentNode.id,
                //   timeoutMs: nodeResult.metadata.fallbackTimeoutMs,
                //   waitCompletionsSize: waitCompletions.size,
                //   hasCurrentNodeInWaitCompletions: waitCompletions.has(
                //     currentNode.id,
                //   ),
                // });

                const signalArrived = await condition(
                  () => {
                    const hasCompletion = waitCompletions.has(currentNode!.id);
                    if (hasCompletion) {
                      log.info(
                        '🚨 DEBUG: Condition function returning true - signal received',
                        {
                          sessionId: input.sessionId,
                          nodeId: currentNode?.id,
                        },
                      );
                    }
                    return hasCompletion;
                  },
                  nodeResult.metadata.fallbackTimeoutMs, // Use calculated timeout
                );

                // log.info('🚨 DEBUG: Race condition completed', {
                //   sessionId: input.sessionId,
                //   nodeId: currentNode?.id,
                //   signalArrived,
                //   hasSignal: waitCompletions.has(currentNode?.id || ''),
                // });

                if (signalArrived) {
                  // Signal received before timeout
                  const signalResult = waitCompletions.get(
                    currentNode?.id || '',
                  );
                  if (!signalResult) {
                    throw new Error(
                      'Wait signal not received despite condition met',
                    );
                  }
                  // log.info('🚨 DEBUG: Using signal result', {
                  //   sessionId: input.sessionId,
                  //   nodeId: currentNode?.id,
                  //   signalResult,
                  // });
                  waitResult = signalResult;
                } else {
                  // Timeout reached - trigger fallback
                  // log.info(
                  //   '🚨 DEBUG: Wait timeout reached, triggering fallback',
                  //   {
                  //     sessionId: input.sessionId,
                  //     nodeId: currentNode?.id,
                  //     timeoutMs: nodeResult.metadata.fallbackTimeoutMs,
                  //   },
                  // );

                  waitResult = {
                    nodeId: currentNode?.id || '',
                    result: 'timeout',
                    completedAt: new Date().toISOString(),
                    metadata: { triggeredBy: 'temporal_timeout' },
                  };
                }
              } else {
                // No timeout - wait indefinitely for signal (up to max 30 days)
                await condition(
                  () => waitCompletions.has(currentNode!.id),
                  '30d', // Maximum 30 days wait
                );

                const signalResult = waitCompletions.get(currentNode.id);
                if (!signalResult) {
                  throw new Error(
                    'Wait signal not received despite condition met',
                  );
                }
                waitResult = signalResult;
              }

              // Ensure DB/session consistency for both signal and timeout outcomes
              try {
                await waitActivitiesProxy.completeWait({
                  sessionId: input.sessionId,
                  nodeId: currentNode.id,
                  result: waitResult.result,
                });
              } catch (e) {
                log.error('Failed to mark wait completion via activity', {
                  sessionId: input.sessionId,
                  nodeId: currentNode.id,
                  error: (e as any)?.message,
                });
              }

              // Clean used completion signal entry if any
              if (waitCompletions.has(currentNode.id)) {
                waitCompletions.delete(currentNode.id);
              }
              isWaiting = false;

              // Determine next node based on wait result.
              //
              // Primary routing is by outgoing-edge handle: the FE Wait node
              // draws `wait-success` / `wait-otherwise` source handles for
              // multi-output waits, so we resolve the handle and let the shared
              // edge-matching logic below (sourceHandle === nextNodeHandle)
              // pick the deterministic target — same contract as
              // conditional/split nodes. (EVO-1912)
              //
              // Legacy id-based routing (successNodeId/otherwiseNodeId/
              // nextNodeId in node-data) is preserved for journeys that
              // explicitly persist those ids; the FE never writes them, so it
              // returns undefined and we fall through to handle routing.
              const [resolvedNextNodeId, resolvedHandle] = await Promise.all([
                actionNodeActivities.processWaitCompletion({
                  nodeId: currentNode.id,
                  contactId: input.contactId,
                  sessionId: input.sessionId,
                  nodeData: currentNode.data,
                  waitResult: waitResult.result,
                }),
                actionNodeActivities.resolveWaitHandle({
                  nodeId: currentNode.id,
                  contactId: input.contactId,
                  sessionId: input.sessionId,
                  nodeData: currentNode.data,
                  waitResult: waitResult.result,
                }),
              ]);

              // Persist on nodeResult so it survives the generic
              // `nextNodeId = nodeResult.nextNodeId` reassignment below.
              nodeResult.nextNodeId = resolvedNextNodeId;
              nodeResult.nextNodeHandle = resolvedHandle;

              // Update variables with wait completion info
              nodeResult.variables = {
                ...nodeResult.variables,
                [`node_${currentNode.id}_wait_completed`]: true,
                [`node_${currentNode.id}_wait_result`]: waitResult.result,
                [`node_${currentNode.id}_completed_at`]: waitResult.completedAt,
              };

              // log.info('Wait completed, continuing journey', {
              //   sessionId: input.sessionId,
              //   nodeId: currentNode.id,
              //   result: waitResult.result,
              //   nextNodeId,
              //   triggeredBy:
              //     waitResult.metadata?.triggeredBy || 'external_signal',
              // });
            }
            break;

          case 'delayed-action':
          case 'delayed-action-node':
          case 'scheduled-action-node':
            nodeResult = await actionNodeActivities.executeScheduledActionNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              journeyId: input.journeyId,
              nodeData: currentNode.data,
            });

            // If this is a scheduled action, mark session as needing to wait
            if (nodeResult.shouldPause) {
              isWaiting = true;

              log.info('Journey paused for scheduled action', {
                sessionId: input.sessionId,
                nodeId: currentNode!.id,
                scheduledFor: nodeResult.metadata?.scheduled_for,
              });

              // Clear any stale completion signal for this node before starting a new wait
              if (waitCompletions.has(currentNode!.id)) {
                waitCompletions.delete(currentNode!.id);
              }

              // Wait indefinitely for scheduled action to complete (will be signaled by scheduled action processor)
              await condition(() => waitCompletions.has(currentNode!.id), '30d');

              const signalResult = waitCompletions.get(currentNode!.id);
              if (!signalResult) {
                throw new Error('Scheduled action signal not received despite condition met');
              }

              // Clean up used completion signal entry
              if (waitCompletions.has(currentNode!.id)) {
                waitCompletions.delete(currentNode!.id);
              }
              isWaiting = false;

              // Scheduled action completed, continue to next node from signal
              nextNodeId = signalResult.metadata?.nextNodeId;
            }
            break;

          case 'addLabel':
          case 'add-label-node': // Support both naming conventions
            nodeResult = await actionNodeActivities.executeAddLabelNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              labelId: currentNode.data.labelId,
              labelName: currentNode.data.labelName,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'removeLabel':
          case 'remove-label-node': // Support both naming conventions
            nodeResult = await actionNodeActivities.executeRemoveLabelNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              labelId: currentNode.data.labelId,
              labelName: currentNode.data.labelName,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'updateContact':
          case 'update-contact-node':
            nodeResult = await actionNodeActivities.executeUpdateContactNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'update-custom-attribute-node':
            nodeResult =
              await actionNodeActivities.executeUpdateCustomAttributeNode({
                nodeId: currentNode.id,
                contactId: input.contactId,
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'split-node':
            nodeResult = await actionNodeActivities.executeSplitNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'set-variable-node':
            nodeResult = await actionNodeActivities.executeSetVariableNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'exit-journey-node':
            nodeResult = await actionNodeActivities.executeExitJourneyNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            // Exit nodes should end the journey - mark status as completed
            state.status = 'completed';
            // Note: Keep currentNode alive for success verification, will be nulled after
            break;

          case 'transfer-journey-node':
            nodeResult = await actionNodeActivities.executeTransferJourneyNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            // Transfer nodes should end the current journey
            // Note: Keep currentNode alive for success verification, will be nulled after
            break;

          case 'trigger':
          case 'journey-trigger-node': // Support both naming conventions
            // Use TriggerNode to process variable mappings
            nodeResult = await actionNodeActivities.executeTriggerNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              triggerEvent: input.triggerEvent,
              nodeData: currentNode.data,
            });
            break;

          case 'send-webhook-node':
            nodeResult = await actionNodeActivities.executeSendWebhookNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              sessionId: input.sessionId,
              // EVO-1882: journeyId is required for interpolateNodeData to load
              // journey-level variable defaults; without it those {{variables}}
              // never resolve.
              journeyId: input.journeyId,
              nodeData: currentNode.data,
            });
            break;

          case 'conditional-node':
            nodeResult = await actionNodeActivities.executeConditionalNode({
              nodeId: currentNode.id,
              contactId: input.contactId,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || undefined,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'send-message-node':
            // console.log('🔍 DEBUG: About to execute send-message-node', {
            //   nodeId: currentNode.id,
            //   nodeDataNextNodeId: currentNode.data?.nextNodeId,
            // });

            // Extract conversationId from trigger event properties (optional)
            const conversationId =
              input.triggerEvent?.properties?.conversation_id;

            nodeResult = await actionNodeActivities.executeSendMessageNode({
              nodeId: currentNode.id,
              conversationId: conversationId || undefined,
              sessionId: input.sessionId,
              contactId: input.contactId, // Pass contactId for creating new conversations
              nodeData: currentNode.data,
            });

            // console.log('🔍 DEBUG: Send message node result', {
            //   sessionId: input.sessionId,
            //   nodeId: currentNode.id,
            //   success: nodeResult.success,
            //   nextNodeId: nodeResult.nextNodeId,
            //   hasError: !!nodeResult.error,
            // });
            break;

          case 'send-canned-response-node':
            nodeResult =
              await actionNodeActivities.executeSendCannedResponseNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || undefined,
                sessionId: input.sessionId,
                contactId: input.contactId,
                nodeData: currentNode.data,
              });
            break;

          case 'send-email-team-node':
            nodeResult = await actionNodeActivities.executeSendEmailTeamNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || undefined,
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'assign-to-pipeline-node':
            nodeResult =
              await actionNodeActivities.executeAssignToPipelineNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || undefined,
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'move-to-pipeline-stage-node':
            nodeResult =
              await actionNodeActivities.executeMoveToPipelineStageNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || undefined,
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'create-pipeline-task-node':
            nodeResult =
              await actionNodeActivities.executeCreatePipelineTaskNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || undefined,
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'send-transcript-node':
            nodeResult = await actionNodeActivities.executeSendTranscriptNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || '',
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'assign-agent-node':
            nodeResult = await actionNodeActivities.executeAssignAgentNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || '',
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'assign-team-node':
            nodeResult = await actionNodeActivities.executeAssignTeamNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || '',
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'assign-bot-node':
            nodeResult = await actionNodeActivities.executeAssignBotNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id ||
                'inbox-level', // Bot assignment can work without specific conversation
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          case 'mute-conversation-node':
            nodeResult = await actionNodeActivities.executeMuteConversationNode(
              {
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || '',
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              },
            );
            break;

          case 'resolve-conversation-node':
            nodeResult =
              await actionNodeActivities.executeResolveConversationNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || '',
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'snooze-conversation-node':
            nodeResult =
              await actionNodeActivities.executeSnoozeConversationNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || '',
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'defer-conversation-node':
            // Defer aliases snooze — same CRM effect ('snoozed').
            nodeResult =
              await actionNodeActivities.executeSnoozeConversationNode({
                nodeId: currentNode.id,
                conversationId:
                  input.triggerEvent?.properties?.conversation_id || '',
                sessionId: input.sessionId,
                nodeData: currentNode.data,
              });
            break;

          case 'change-priority-node':
            nodeResult = await actionNodeActivities.executeChangePriorityNode({
              nodeId: currentNode.id,
              conversationId:
                input.triggerEvent?.properties?.conversation_id || '',
              sessionId: input.sessionId,
              nodeData: currentNode.data,
            });
            break;

          default:
            // log.warn('Unknown node type, skipping', {
            //   sessionId: input.sessionId,
            //   nodeId: currentNode.id,
            //   nodeType: currentNode.type,
            // });

            // Skip unknown node types
            nodeResult = {
              success: true,
              nextNodeId: currentNode.data.nextNodeId,
            };
            break;
        }

        // Update journey variables with node execution results
        if (nodeResult.variables) {
          state.variables = { ...state.variables, ...nodeResult.variables };
        }

        // log.info('Node execution result', {
        //   sessionId: input.sessionId,
        //   nodeId: currentNode?.id,
        //   nodeType: currentNode?.type,
        //   success: nodeResult.success,
        //   hasError: !!nodeResult.error,
        //   errorMessage: nodeResult.error,
        //   hasNextNodeId: !!nodeResult.nextNodeId,
        //   nextNodeId: nodeResult.nextNodeId,
        //   executionTime: nodeResult.executionTime,
        // });

        // Mark node as completed if successful
        if (nodeResult.success && currentNode) {
          state.completedNodes.push(currentNode.id);
          state.metadata.lastProcessedNode = {
            id: currentNode.id,
            type: currentNode.type,
            processedAt: new Date().toISOString(),
            executionTime: nodeResult.executionTime,
          };

          // Run ALL completion operations in parallel - variables, logging, tracking
          const completionTasks = [
            activities.logNodeExecution({
              sessionId: input.sessionId,
              nodeId: currentNode.id,
              nodeType: currentNode.type,
              status: 'completed',
              executionTime: nodeResult.executionTime,
              result: nodeResult,
            }),
            trackingActivities.trackNodeExecution(trackingContext, {
              nodeId: currentNode.id,
              nodeType: currentNode.type,
              status: 'completed',
              endTime: new Date(),
              executionTime: nodeResult.executionTime,
            }),
          ];

          // Add variables update to parallel tasks if needed
          if (nodeResult.variables) {
            completionTasks.push(
              activities.updateJourneySession({
                sessionId: input.sessionId,
                updates: {
                  variables: state.variables,
                },
              }),
            );
          }

          await Promise.all(completionTasks);

          // log.info('Node executed successfully', {
          //   sessionId: input.sessionId,
          //   nodeId: currentNode.id,
          //   nodeType: currentNode.type,
          //   executionTime: nodeResult.executionTime,
          // });

          // For exit and transfer nodes, nullify currentNode after successful processing
          // This signals that the journey should end without looking for next nodes
          if (
            currentNode.type === 'exit-journey-node' ||
            currentNode.type === 'transfer-journey-node'
          ) {
            // log.info('Journey terminating node processed successfully', {
            //   sessionId: input.sessionId,
            //   nodeId: currentNode.id,
            //   nodeType: currentNode.type,
            // });
            currentNode = null;
            break; // Exit the while loop - journey is complete
          }
        } else {
          // Node execution failed - log failure
          if (currentNode) {
            await activities.logNodeExecution({
              sessionId: input.sessionId,
              nodeId: currentNode.id,
              nodeType: currentNode.type,
              status: 'failed',
              error: nodeResult.error,
            });

            // Track node execution failed
            await trackingActivities.trackNodeExecution(trackingContext, {
              nodeId: currentNode.id,
              nodeType: currentNode.type,
              status: 'failed',
              endTime: new Date(),
              error: nodeResult.error,
            });
          }

          // Node execution failed
          log.error('Node execution failed', {
            sessionId: input.sessionId,
            nodeId: currentNode?.id,
            nodeType: currentNode?.type,
            error: nodeResult.error,
          });

          // For now, stop journey execution on node failure
          // TODO: Implement error handling strategies (retry, skip, alternate path)
          const errorMessage = nodeResult.error || 'Unknown error';
          throw new Error(`Node execution failed: ${errorMessage}`);
        }

        // Determine next node using flow edges
        nextNodeId = nodeResult.nextNodeId;

        // console.log('🔍 DEBUG: Next node determination', {
        //   sessionId: input.sessionId,
        //   currentNodeId: currentNode?.id,
        //   currentNodeType: currentNode?.type,
        //   nextNodeIdFromResult: nextNodeId,
        //   nextNodeHandleFromResult: nodeResult.nextNodeHandle,
        //   willUseEdges: !nextNodeId,
        // });

        // If no nextNodeId from node result, use flow edges to find next node
        if (!nextNodeId && currentNode) {
          const outgoingEdges = journey.flowData.edges?.filter(
            (edge) => edge.source === currentNode!.id,
          );

          // log.info('🔍 DEBUG: Searching for next node via edges', {
          //   sessionId: input.sessionId,
          //   currentNodeId: currentNode.id,
          //   currentNodeType: currentNode.type,
          //   nextNodeHandle: nodeResult.nextNodeHandle,
          //   totalEdges: outgoingEdges?.length || 0,
          //   allEdges: outgoingEdges?.map((edge: any) => ({
          //     source: edge.source,
          //     target: edge.target,
          //     sourceHandle: edge.sourceHandle,
          //     targetHandle: edge.targetHandle,
          //   })),
          // });

          if (outgoingEdges && outgoingEdges.length > 0) {
            // Check if this is a multi-output node (like split or wait with fallback)
            if (nodeResult.nextNodeHandle) {
              // Find edge matching the specific handle
              const targetEdge = outgoingEdges.find(
                (edge: any) => edge.sourceHandle === nodeResult.nextNodeHandle,
              );

              // log.info('🔍 DEBUG: Handle-based edge matching', {
              //   sessionId: input.sessionId,
              //   lookingForHandle: nodeResult.nextNodeHandle,
              //   foundEdge: targetEdge
              //     ? {
              //         source: targetEdge.source,
              //         target: targetEdge.target,
              //         sourceHandle: (targetEdge as any).sourceHandle,
              //       }
              //     : null,
              //   fallbackToFirst: !targetEdge,
              // });

              nextNodeId = targetEdge?.target || outgoingEdges[0].target;
            } else {
              // Take the first edge for single-output nodes
              nextNodeId = outgoingEdges[0].target;
            }

            // log.info('Found next node via flow edges', {
            //   sessionId: input.sessionId,
            //   currentNodeId: currentNode.id,
            //   nextNodeId,
            //   totalEdges: outgoingEdges.length,
            //   handle: nodeResult.nextNodeHandle,
            // });
          }
        }

        if (nextNodeId && currentNode) {
          // Find next node in journey data
          const nextNode = journey.flowData.nodes?.find(
            (node) => node.id === nextNodeId,
          );

          if (nextNode) {
            // Update state immediately
            state.currentNodeId = nextNode.id;
            currentNode = nextNode;

            // log.info('Moving to next node', {
            //   sessionId: input.sessionId,
            //   fromNodeId: state.completedNodes[state.completedNodes.length - 1],
            //   toNodeId: nextNode.id,
            //   toNodeType: nextNode.type,
            // });

            // Run tracking and session update in parallel for speed
            await Promise.all([
              trackingActivities.trackNodeTransition(trackingContext, {
                fromNodeId:
                  state.completedNodes[state.completedNodes.length - 1],
                fromNodeType: currentNode.type,
                toNodeId: nextNode.id,
                toNodeType: nextNode.type,
                handle: nodeResult.nextNodeHandle,
              }),
              activities.updateJourneySession({
                sessionId: input.sessionId,
                updates: {
                  currentNodeId: state.currentNodeId,
                },
              }),
            ]);
          } else {
            log.warn('Next node not found in flow data, ending journey', {
              sessionId: input.sessionId,
              nextNodeId,
            });
            break;
          }
        } else {
          if (currentNode) {
            // Only log but keep the journey in a waiting state
            // Journey should only complete via exit-journey-node
            // log.info(
            //   'No next node found (no outgoing edges), journey remains active indefinitely',
            //   {
            //     sessionId: input.sessionId,
            //     currentNodeId: currentNode.id,
            //   },
            // );

            // Keep the workflow running indefinitely waiting for signals
            // The journey will stay active until:
            // 1. Cancelled via signal (cancelJourneySignal)
            // 2. Workflow times out (Temporal's max duration)
            // It will NEVER auto-complete just because there are no more nodes
            try {
              await condition(() => false, '30d'); // Wait up to 30 days (Temporal's max)
              // If we reach here, it means 30 days passed
              // Still don't complete - just keep the state as is
              // log.warn('Journey reached 30-day wait limit without exit node', {
              //   sessionId: input.sessionId,
              //   currentNodeId: currentNode.id,
              // });
            } catch (timeoutError) {
              // Timeout reached, but we still don't mark as completed
              log.error('Journey wait timeout', {
                sessionId: input.sessionId,
                error: timeoutError.message,
              });
            }
          }
          break;
        }
      } catch (nodeError) {
        log.error('Node processing error', {
          sessionId: input.sessionId,
          nodeId: currentNode?.id,
          error: nodeError.message,
        });

        // Re-throw to fail the journey
        throw nodeError;
      }
    }

    // Only mark as completed if we explicitly exited via exit-journey-node
    // or if the journey was cancelled/failed via signals
    if (state.status === 'running') {
      // Journey ended without exit node - keep it active
      log.info(
        'Journey reached end without exit-journey-node, keeping active',
        {
          sessionId: input.sessionId,
          completedNodes: state.completedNodes.length,
        },
      );

      // Don't mark as completed - the journey stays in "active" state
      // waiting for potential future actions or manual intervention
      return state;
    }

    // Journey was explicitly completed via exit-journey-node or signal
    state.metadata.completedAt = new Date().toISOString();

    // Calculate total execution time
    const startTime = new Date(state.metadata.startedAt).getTime();
    const endTime = new Date().getTime();
    const totalExecutionTime = endTime - startTime;

    await activities.updateJourneySession({
      sessionId: input.sessionId,
      updates: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    // Track journey completed
    await trackingActivities.trackJourneyCompleted(trackingContext, {
      completedNodes: state.completedNodes,
      totalExecutionTime,
      finalStatus: 'completed',
    });

    log.info('Journey execution completed successfully', {
      sessionId: input.sessionId,
      completedNodes: state.completedNodes.length,
    });
  } catch (error) {
    log.error('Journey execution failed', {
      sessionId: input.sessionId,
      error: error.message,
    });

    state.status = 'failed';
    state.metadata.failedAt = new Date().toISOString();
    state.metadata.error = error.message;

    await activities.updateJourneySession({
      sessionId: input.sessionId,
      updates: {
        status: 'failed',
        errorMessage: error.message,
        failedAt: new Date(),
      },
    });

    // Track journey failed
    await trackingActivities.trackJourneyFailed(trackingContext, {
      error: (error as any).message || 'Unknown error',
      failedNodeId: state.currentNodeId,
      completedNodes: state.completedNodes,
    });

    throw error;
  }

  return state;
}
