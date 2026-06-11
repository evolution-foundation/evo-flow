import {
  proxyActivities,
  defineSignal,
  setHandler,
  workflowInfo,
  log,
  uuid4,
} from '@temporalio/workflow';
import type {
  CampaignExecutionActivities,
  ComputeCampaignAudienceOutput,
  CreateCampaignBatchesOutput,
} from '../activities/campaign-execution.activities';

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
  // Deterministic UUID (replay-safe) shared across every downstream message
  // and structured log in the distributed pipeline (campaigns.pack/send/tracked).
  const correlationId = uuid4();
  const workflowId = workflowInfo().workflowId;

  // Lifecycle signals are kept so CampaignWorkflowService's signal API does not
  // fail, but the workflow now returns in <5s after the hand-off — real
  // pause/stop of an in-flight dispatch is delivered by story 4.8 via
  // `campaigns.control`. These handlers only annotate the returned state.
  setHandler(pauseCampaignSignal, () => {
    state.status = 'paused';
    log.info('Campaign workflow pause signal received', {
      campaignId: input.campaignId,
    });
  });

  setHandler(resumeCampaignSignal, () => {
    log.info('Campaign workflow resume signal received', {
      campaignId: input.campaignId,
    });
  });

  setHandler(cancelCampaignSignal, () => {
    state.status = 'cancelled';
    state.completedAt = new Date().toISOString();
    log.info('Campaign workflow cancellation signal received', {
      campaignId: input.campaignId,
    });
  });

  log.info('🚀 Starting Campaign Execution Workflow (distributed dispatch)', {
    campaignId: input.campaignId,
    correlationId,
  });

  try {
    // ========== STEP 1: Validate Campaign ==========
    const campaign = await activities.getCampaignData({
      campaignId: input.campaignId,
    });

    log.info('Campaign data loaded', {
      campaignId: campaign.id,
      type: campaign.type,
      channelType: campaign.channelType,
    });

    // ========== STEP 2: Mark Campaign as Sending ==========
    await activities.updateCampaignStatus({
      campaignId: input.campaignId,
      status: CAMPAIGN_STATUS.SENDING,
    });

    // ========== STEP 3: Hand off to the distributed pipeline ==========
    // Publish a single `campaigns.pack` and return. The packer resolves the
    // audience + paginates, the sender dispatches, and the campaign-tracker
    // aggregates `campaigns.tracked` and transitions the campaign to Completed.
    // The workflow waits on none of it (4.6 / EVO-1220 is broker-native, not a
    // Temporal signal), so this returns in <5s instead of blocking for the whole
    // send.
    state.status = 'sending';
    await activities.publishCampaignsPack({
      campaignId: input.campaignId,
      correlationId,
    });

    // The workflow's job ends at the hand-off — the send itself runs in the
    // distributed pipeline and the campaign-tracker (4.6) drives Campaign.status
    // to Completed in Postgres. Close the CampaignExecution row now so it stops
    // counting as an active execution; otherwise it stays RUNNING forever and
    // blocks any re-run (getActiveExecution gate) and makes pause/stop signal an
    // already-completed workflow. Run progress lives in Campaign, not here.
    await activities.updateExecutionProgress({
      campaignId: input.campaignId,
      workflowId,
      status: 'completed',
    });

    log.info('✅ Campaign dispatch handed off to campaigns.pack', {
      campaignId: input.campaignId,
      correlationId,
    });

    return state;
  } catch (error) {
    log.error('❌ Campaign dispatch hand-off failed', {
      campaignId: input.campaignId,
      error: error.message,
      stack: error.stack,
    });

    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = error.message;

    // Best-effort: flip the campaign to STOPPED and close the execution row so a
    // failed hand-off does not leave the campaign stuck in SENDING nor the
    // CampaignExecution stuck RUNNING (which would block re-runs). The thrown
    // error still surfaces to Temporal for its retry/visibility.
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
