import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

interface MoveResponseData {
  moved?: boolean;
  skipped?: boolean;
  reason?: string;
  movement_type?: string;
}

export interface MoveToPipelineStageNodeInput {
  nodeId: string;
  conversationId?: string;
  sessionId: string;
  nodeData: {
    pipeline_id?: string;
    pipelineId?: string;
    stage_id?: string;
    pipeline_stage_id?: string;
    nextNodeId?: string;
  };
}

export class MoveToPipelineStageNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('move-to-pipeline-stage');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) this.crmService = new CrmClientService();
    return this.crmService;
  }

  async execute(
    input: MoveToPipelineStageNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const data = await this.interpolateNodeData(input, input.nodeData);
      const pipelineId = data.pipeline_id || data.pipelineId;
      const stageId = data.pipeline_stage_id || data.stage_id;

      if (!stageId) {
        this.logger.warn('No stage_id configured; skipping', {
          nodeId: input.nodeId,
        });
        return this.skipped('no_stage_id', pipelineId, stageId);
      }
      if (!pipelineId) {
        this.logger.warn('No pipeline_id configured; skipping', {
          nodeId: input.nodeId,
        });
        return this.skipped('no_pipeline_id', pipelineId, stageId);
      }
      if (!input.conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });
        return this.skipped('no_conversation_id', pipelineId, stageId);
      }

      const response = await this.getCrmService().moveToPipelineStage(
        String(pipelineId),
        input.conversationId,
        String(stageId),
        'move-to-pipeline-stage',
      );

      if (!response.success) {
        throw new Error(
          `Failed to move conversation to pipeline stage: ${response.error}`,
        );
      }

      // The CRM wraps payloads in a `success_response` envelope
      // (`{ success, data, meta }`), and executeRequest stores that whole body
      // under `response.data` — so the move result lives at `response.data.data`.
      const envelope = (response.data ?? {}) as { data?: MoveResponseData };
      const crmData = (envelope.data ?? {}) as MoveResponseData;

      // A deleted/invalid target stage degrades to a logged skip on the CRM
      // side (AC3) — surface it as skipped rather than a successful move.
      if (crmData.skipped) {
        this.logger.warn('CRM skipped the move', {
          nodeId: input.nodeId,
          reason: crmData.reason,
        });
        return {
          moved: false,
          skipped: true,
          reason: crmData.reason || 'stage_not_found',
          pipelineId,
          stageId,
          conversationId: input.conversationId,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        moved: true,
        movementType: crmData.movement_type,
        pipelineId,
        stageId,
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        crmResponse: crmData,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_pipeline_moved`]: result.moved,
          [`node_${input.nodeId}_pipeline_id`]: result.pipelineId,
          [`node_${input.nodeId}_stage_id`]: result.stageId,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to move conversation to pipeline stage', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }

  private skipped(reason: string, pipelineId?: string, stageId?: string) {
    return {
      moved: false,
      skipped: true,
      reason,
      pipelineId,
      stageId,
      timestamp: new Date().toISOString(),
    };
  }
}
