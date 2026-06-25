import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

interface CreateTaskResponseData {
  created?: boolean;
  skipped?: boolean;
  reason?: string;
  task_id?: string;
}

export interface CreatePipelineTaskNodeInput {
  nodeId: string;
  conversationId?: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    title?: string;
    description?: string;
    task_type?: string;
    priority?: string;
    assigned_to_id?: string;
    due_date?: { value?: number; unit?: string } | null;
    nextNodeId?: string;
  };
}

export class CreatePipelineTaskNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('create-pipeline-task', 'conversation');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) this.crmService = new CrmClientService();
    return this.crmService;
  }

  async execute(
    input: CreatePipelineTaskNodeInput,
  ): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const data = await this.interpolateNodeData(input, input.nodeData);
      const title = data.title?.trim();

      if (!title) {
        this.logger.warn('No title configured; skipping', {
          nodeId: input.nodeId,
        });
        return this.skipped('no_title');
      }
      if (!input.conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });
        return this.skipped('no_conversation_id');
      }

      const response = await this.getCrmService().createPipelineTask(
        input.conversationId,
        {
          title,
          description: data.description,
          task_type: data.task_type,
          priority: data.priority,
          assigned_to_id: data.assigned_to_id,
          due_in: this.toDueIn(data.due_date),
        },
        'create-pipeline-task',
      );

      if (!response.success) {
        throw new Error(`Failed to create pipeline task: ${response.error}`);
      }

      // The CRM wraps payloads in a `success_response` envelope, and
      // executeRequest stores the whole body under `response.data` — the task
      // result lives one level deeper at `response.data.data`.
      const envelope = (response.data ?? {}) as {
        data?: CreateTaskResponseData;
      };
      const crmData = envelope.data ?? {};

      if (crmData.skipped) {
        this.logger.warn('CRM skipped the task creation', {
          nodeId: input.nodeId,
          reason: crmData.reason,
        });
        return {
          created: false,
          skipped: true,
          reason: crmData.reason || 'no_pipeline_item',
          taskId: undefined as string | undefined,
          conversationId: input.conversationId,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        created: true,
        taskId: crmData.task_id,
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        crmResponse: crmData,
      };
    })
      .then(({ result, executionTime }) => {
        if (result?.skipped) {
          return this.createSkippedResult(result.reason, executionTime);
        }
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_task_created`]: result.created,
          [`node_${input.nodeId}_task_id`]: result.taskId,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to create pipeline task', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }

  // Maps the panel's relative due-date `{ value, unit }` to the CRM's
  // `"<value>.<unit>"` form (e.g. `"2.hours"`); absent/incomplete config means
  // no due date.
  private toDueIn(
    due?: { value?: number; unit?: string } | null,
  ): string | undefined {
    if (!due || due.value === undefined || !due.unit) return undefined;
    return `${due.value}.${due.unit}`;
  }

  private skipped(reason: string) {
    return {
      created: false,
      skipped: true,
      reason,
      taskId: undefined as string | undefined,
      timestamp: new Date().toISOString(),
    };
  }
}
