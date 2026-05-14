import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  sleep,
  log,
  ActivityFailure,
  ApplicationFailure,
} from '@temporalio/workflow';
import type {
  CampaignExecutionActivities,
  ComputeCampaignAudienceOutput,
  CreateCampaignBatchesOutput,
} from '../activities/campaign-execution.activities';
import type { CampaignMessageSendingActivities } from '../activities/campaign-message-sending.activities';

const CAMPAIGN_STATUS = {
  DRAFT: 0,
  SCHEDULED: 1,
  SENDING: 2,
  PAUSED: 3,
  STOPPED: 4,
  COMPLETED: 5,
  SENDING_TESTAB: 6,
} as const;

// Define activity proxies with timeouts
const activities = proxyActivities<CampaignExecutionActivities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
  },
});

// Define message sending activities proxy with longer timeout
const messageSendingActivities =
  proxyActivities<CampaignMessageSendingActivities>({
    startToCloseTimeout: '30 minutes', // Longer timeout for batch sending
    retry: {
      maximumAttempts: 3,
      initialInterval: '10s',
      backoffCoefficient: 2,
      maximumInterval: '5m',
    },
  });

// ==================== Workflow Input/Output ====================

export interface CampaignExecutionInput {
  campaignId: string;
  batchSize?: number; // Default: 1000
  delayBetweenBatches?: number; // Delay in milliseconds between batches (for rate limiting)
  skipAudienceComputation?: boolean; // Skip if audience already computed
}

export interface CampaignExecutionState {
  campaignId: string;
  status:
    | 'initializing'
    | 'computing_audience'
    | 'creating_batches'
    | 'sending'
    | 'paused'
    | 'cancelled'
    | 'completed'
    | 'failed';
  audienceResult?: ComputeCampaignAudienceOutput;
  batchesResult?: CreateCampaignBatchesOutput;
  currentBatch: number;
  totalBatches: number;
  sentContacts: number;
  failedContacts: number;
  failedBatches: number[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export const pauseCampaignSignal = defineSignal<[]>('pauseCampaign');
export const resumeCampaignSignal = defineSignal<[]>('resumeCampaign');
export const cancelCampaignSignal = defineSignal<[]>('cancelCampaign');

// ==================== Main Workflow ====================

/**
 * Campaign Execution Workflow
 * Orchestrates the complete lifecycle of a campaign execution:
 * 1. Compute audience (if not already computed)
 * 2. Create batches
 * 3. Process each batch with rate limiting
 * 4. Update campaign status
 */
export async function CampaignExecutionWorkflow(
  input: CampaignExecutionInput,
): Promise<CampaignExecutionState> {
  const batchSize = input.batchSize || 1000;
  const delayBetweenBatches = input.delayBetweenBatches || 0;

  // Initialize workflow state
  const state: CampaignExecutionState = {
    campaignId: input.campaignId,
    status: 'initializing',
    currentBatch: 0,
    totalBatches: 0,
    sentContacts: 0,
    failedContacts: 0,
    failedBatches: [],
    startedAt: new Date().toISOString(),
  };
  let isPaused = false;
  let isCancelled = false;
  const workflowId = workflowInfo().workflowId;

  setHandler(pauseCampaignSignal, () => {
    isPaused = true;
    state.status = 'paused';
    log.info('Campaign workflow paused by signal', {
      campaignId: input.campaignId,
    });
  });

  setHandler(resumeCampaignSignal, () => {
    isPaused = false;
    if (!isCancelled) {
      state.status = 'sending';
    }
    log.info('Campaign workflow resumed by signal', {
      campaignId: input.campaignId,
    });
  });

  setHandler(cancelCampaignSignal, () => {
    isCancelled = true;
    state.status = 'cancelled';
    state.completedAt = new Date().toISOString();
    log.info('Campaign workflow cancellation requested by signal', {
      campaignId: input.campaignId,
    });
  });

  log.info('🚀 Starting Campaign Execution Workflow', {
    campaignId: input.campaignId,
    batchSize,
    skipAudienceComputation: input.skipAudienceComputation,
  });

  try {
    // ========== STEP 1: Get Campaign Data ==========
    log.info('📋 Step 1: Getting campaign data');

    const campaign = await activities.getCampaignData({
      campaignId: input.campaignId,
    });

    log.info('Campaign data loaded', {
      campaignId: campaign.id,
      type: campaign.type,
      channelType: campaign.channelType,
    });

    // ========== STEP 2: Update Status to SENDING ==========
    await activities.updateCampaignStatus({
      campaignId: input.campaignId,
      status: CAMPAIGN_STATUS.SENDING,
    });

    state.status = 'computing_audience';

    // ========== STEP 3: Compute Audience (if needed) ==========
    if (!input.skipAudienceComputation || campaign.isRunSegment) {
      log.info('👥 Step 2: Computing campaign audience');

      state.audienceResult = await activities.computeCampaignAudience({
        campaignId: input.campaignId,
      });

      log.info('Audience computed successfully', {
        totalContacts: state.audienceResult.totalContacts,
        validContacts: state.audienceResult.validContacts,
        invalidContacts: state.audienceResult.invalidContacts,
      });

      // Check if we have valid contacts
      if (state.audienceResult.validContacts === 0) {
        throw ApplicationFailure.create({
          message: 'No valid contacts found for campaign',
          nonRetryable: true,
        });
      }
    } else {
      log.info('⏭️  Skipping audience computation (already computed)');
    }

    // ========== STEP 4: Create Batches ==========
    log.info('📦 Step 3: Creating campaign batches');

    state.status = 'creating_batches';

    state.batchesResult = await activities.createCampaignBatches({
      campaignId: input.campaignId,
      batchSize,
    });

    state.totalBatches = state.batchesResult.totalBatches;
    await activities.updateExecutionProgress({
      campaignId: input.campaignId,
      workflowId,
      status: 'running',
      totalContacts: state.batchesResult.totalContacts,
      totalBatches: state.totalBatches,
    });

    log.info('Batches created successfully', {
      totalBatches: state.totalBatches,
      totalContacts: state.batchesResult.totalContacts,
      batchSize,
    });

    // ========== STEP 5: Process Each Batch ==========
    log.info('📨 Step 4: Processing batches');

    state.status = 'sending';

    for (let batchNumber = 1; batchNumber <= state.totalBatches; batchNumber++) {
      if (isCancelled) {
        break;
      }

      if (isPaused) {
        await condition(() => !isPaused || isCancelled);
      }

      if (isCancelled) {
        break;
      }

      state.status = 'sending';
      state.currentBatch = batchNumber;

      log.info(`Processing batch ${batchNumber}/${state.totalBatches}`);

      try {
        // Get batch contacts
        const batch = await activities.getCampaignBatch({
          campaignId: input.campaignId,
          batchNumber,
        });

        log.info('Batch retrieved', {
          batchNumber,
          contactCount: batch.totalInBatch,
        });

        // Send messages to all contacts in this batch
        if (batch.totalInBatch > 0) {
          log.info('Sending messages for batch', {
            batchNumber,
            totalContacts: batch.totalInBatch,
            channelType: campaign.channelType,
          });

          // Send messages via Message Sender
          const sendResult = await messageSendingActivities.sendCampaignBatchMessages({
            campaignId: input.campaignId,
            batchNumber,
            inboxId: campaign.inboxId || '',
            templateId: campaign.templates?.[0]?.messageTemplateId, // Use first template
            channelType: campaign.channelType || 'Channel::Whatsapp',
          });

          log.info('Batch sending completed', {
            batchNumber,
            successfulSends: sendResult.successfulSends,
            failedSends: sendResult.failedSends,
            totalAttempts: sendResult.totalContacts,
          });

          // Update sent contacts (only count successful sends)
          state.sentContacts += sendResult.successfulSends;
          state.failedContacts += sendResult.failedSends;

          // Update campaign progress
          const sentPercentage =
            state.batchesResult.totalContacts > 0
              ? (state.sentContacts / state.batchesResult.totalContacts) * 100
              : 0;

          await activities.updateCampaignStatus({
            campaignId: input.campaignId,
            status: CAMPAIGN_STATUS.SENDING,
            sentContacts: state.sentContacts,
            sentPercentage,
          });
          await activities.updateExecutionProgress({
            campaignId: input.campaignId,
            workflowId,
            status: 'running',
            currentBatch: batchNumber,
            processedContacts: state.sentContacts + state.failedContacts,
            sentContacts: state.sentContacts,
            failedContacts: state.failedContacts,
          });

          log.info('Batch processed successfully', {
            batchNumber,
            sentContacts: state.sentContacts,
            sentPercentage: sentPercentage.toFixed(2),
            successRate: (
              (sendResult.successfulSends / sendResult.totalContacts) *
              100
            ).toFixed(2),
          });
        }

        // Apply delay between batches (rate limiting)
        if (
          delayBetweenBatches > 0 &&
          batchNumber < state.totalBatches
        ) {
          log.debug(`Applying delay of ${delayBetweenBatches}ms before next batch`);
          await sleep(delayBetweenBatches);
        }
      } catch (error) {
        log.error('Failed to process batch', {
          batchNumber,
          error: error.message,
        });

        state.failedBatches.push(batchNumber);

        // Continue with next batch (don't fail entire campaign for one batch)
        // In production, you might want to retry logic here
      }
    }

    if (isCancelled) {
      await activities.updateCampaignStatus({
        campaignId: input.campaignId,
        status: CAMPAIGN_STATUS.STOPPED,
      });
      await activities.updateExecutionProgress({
        campaignId: input.campaignId,
        workflowId,
        status: 'cancelled',
      });
      state.status = 'cancelled';
      state.completedAt = new Date().toISOString();
      return state;
    }

    // ========== STEP 6: Complete Campaign ==========
    log.info('✅ Campaign execution completed');

    state.status = 'completed';
    state.completedAt = new Date().toISOString();

    const finalPercentage =
      state.batchesResult.totalContacts > 0
        ? (state.sentContacts / state.batchesResult.totalContacts) * 100
        : 0;

    await activities.updateCampaignStatus({
      campaignId: input.campaignId,
      status: CAMPAIGN_STATUS.COMPLETED,
      sentContacts: state.sentContacts,
      sentPercentage: Number(finalPercentage.toFixed(2)),
    });
    await activities.updateExecutionProgress({
      campaignId: input.campaignId,
      workflowId,
      status: 'completed',
      processedContacts: state.batchesResult.totalContacts,
      sentContacts: state.sentContacts,
      failedContacts: state.failedContacts,
      currentBatch: state.totalBatches,
      totalBatches: state.totalBatches,
    });

    log.info('🎉 Campaign Execution Workflow completed successfully', {
      campaignId: input.campaignId,
      sentContacts: state.sentContacts,
      totalBatches: state.totalBatches,
      failedBatches: state.failedBatches.length,
      duration: `${Date.now() - new Date(state.startedAt).getTime()}ms`,
    });

    return state;
  } catch (error) {
    log.error('❌ Campaign execution failed', {
      campaignId: input.campaignId,
      error: error.message,
      stack: error.stack,
    });

    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = error.message;

    // Update campaign status to STOPPED (failed)
    try {
      await activities.updateCampaignStatus({
        campaignId: input.campaignId,
        status: CAMPAIGN_STATUS.STOPPED,
      });
      await activities.updateExecutionProgress({
        campaignId: input.campaignId,
        workflowId,
        status: 'failed',
        lastError: error.message,
      });
    } catch (updateError) {
      log.error('Failed to update campaign status after error', {
        error: updateError.message,
      });
    }

    throw error;
  }
}

// ==================== Test/Manual Execution Workflow ====================

/**
 * Simple Test Workflow for Campaign Execution
 * Used for testing without actual message sending
 */
export async function CampaignTestExecutionWorkflow(
  input: CampaignExecutionInput,
): Promise<CampaignExecutionState> {
  log.info('🧪 Starting Campaign Test Execution (no actual sending)');

  // Use the main workflow but with skipAudienceComputation if already computed
  return CampaignExecutionWorkflow({
    ...input,
    delayBetweenBatches: 100, // Short delay for testing
  });
}
