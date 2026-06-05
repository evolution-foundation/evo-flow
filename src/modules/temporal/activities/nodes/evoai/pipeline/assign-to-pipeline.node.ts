import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface AssignToPipelineNodeInput {
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

export class AssignToPipelineNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('assign-to-pipeline');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) this.crmService = new CrmClientService();
    return this.crmService;
  }

  async execute(
    input: AssignToPipelineNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const data = await this.interpolateNodeData(input, input.nodeData);
      const pipelineId = data.pipeline_id || data.pipelineId;
      const stageId = data.pipeline_stage_id || data.stage_id;

      if (!pipelineId) {
        this.logger.warn('No pipeline_id configured; skipping', {
          nodeId: input.nodeId,
        });
        return {
          assigned: false,
          skipped: true,
          reason: 'no_pipeline_id',
          timestamp: new Date().toISOString(),
        };
      }
      if (!input.conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });
        return {
          assigned: false,
          skipped: true,
          reason: 'no_conversation_id',
          timestamp: new Date().toISOString(),
        };
      }

      const response = await this.getCrmService().addToPipeline(
        String(pipelineId),
        input.conversationId,
        stageId ? String(stageId) : undefined,
        'assign-to-pipeline',
      );

      if (!response.success) {
        throw new Error(
          `Failed to add conversation to pipeline: ${response.error}`,
        );
      }

      return {
        assigned: true,
        pipelineId,
        stageId,
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_pipeline_assigned`]: result.assigned,
          [`node_${input.nodeId}_pipeline_id`]: result.pipelineId,
          [`node_${input.nodeId}_stage_id`]: result.stageId,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to assign conversation to pipeline', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
