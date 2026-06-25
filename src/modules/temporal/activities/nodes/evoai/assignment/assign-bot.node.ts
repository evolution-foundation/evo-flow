import { BaseNode, NodeExecutionResult } from '../../base.node';
import { CrmClientService } from '../../../../../../shared/crm-client/crm-client.service';

export interface AssignBotNodeInput {
  nodeId: string;
  conversationId: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} via interpolateNodeData
  nodeData: {
    bot_id?: string;
    bot_name?: string;
    inbox_id?: string;
    inbox_name?: string;
    nextNodeId?: string;
  };
}

export class AssignBotNode extends BaseNode {
  private crmService: CrmClientService;

  constructor() {
    super('assign-bot');
    this.crmService = new CrmClientService();
  }

  async execute(input: AssignBotNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );
      const { bot_id, inbox_id } = interpolatedNodeData;

      // Validate required fields
      if (!inbox_id) {
        throw new Error('Inbox ID is required for bot assignment');
      }

      // Execute bot assignment via CRM API
      const response = await this.crmService.assignBot(
        inbox_id,
        bot_id || null,
      );

      if (!response.success) {
        throw new Error(`Failed to assign bot: ${response.error}`);
      }

      // Determine assignment action
      const isUnassignment = !bot_id;
      const action = isUnassignment ? 'unassigned' : 'assigned';

      // EVO-1919 hardening: POST /inboxes/:id/set_agent_bot returns 200 even
      // when it never creates the agent_bot_inboxes binding (D11). Re-read the
      // inbox's bound bot (GET /inboxes/:id/agent_bot) and confirm the binding
      // matches the requested state; fail the node when the effect is
      // unconfirmed.
      //
      // EVO-1930: the re-read targets the correct inbox resource, but the
      // confirm predicate parsed the wrong level of the CRM envelope. The CRM
      // (AgentBotSerializer) wraps the bot under `data.agent_bot` when a binding
      // exists ({ success, data: { agent_bot: {...}, configuration: {...} } }),
      // and returns `data: null` when there is no binding. The previous code
      // read `.id` off the `{ agent_bot, configuration }` wrapper (which has no
      // `id`), so a present binding produced `boundBotId === null` → false
      // negative ("does not reflect ... after re-read"). Unwrap `agent_bot`.
      const verification = await this.crmService.verifyEffect<any>(
        { nodeType: 'assign-bot', resourceId: inbox_id },
        () => this.crmService.getInboxBot(inbox_id),
        (botResponse: any) => {
          // getInboxBot → CrmApiResponse whose `data` is the full CRM body:
          // { success, data: { agent_bot, configuration } | null, meta }.
          const body = botResponse?.data;
          const envelope = body?.data ?? body;
          // Bound state nests the bot under `agent_bot`; tolerate a flattened
          // shape too (agent_bot directly), but never treat the wrapper as the
          // bot itself.
          const boundBot = envelope?.agent_bot ?? null;
          const boundBotId =
            boundBot?.id !== undefined && boundBot?.id !== null
              ? String(boundBot.id)
              : null;
          if (isUnassignment) {
            return boundBotId === null;
          }
          return boundBotId === String(bot_id);
        },
      );

      if (verification.verified && !verification.confirmed) {
        throw new Error(
          `Bot ${action} not persisted: CRM accepted the request (2xx) but the ` +
            `inbox ${inbox_id} bot binding does not reflect ` +
            `${isUnassignment ? 'unassignment' : `bot ${bot_id}`} after re-read`,
        );
      }

      // Log successful assignment/unassignment
      this.logger.log(`Bot ${action} successfully`, {
        conversationId: input.conversationId,
        botId: bot_id || 'none',
        inboxId: inbox_id,
        action,
        nodeId: input.nodeId,
        effectVerified: verification.verified,
      });

      return {
        botAssigned: !isUnassignment,
        botUnassigned: isUnassignment,
        assignedBotId: bot_id || null,
        inboxId: inbox_id,
        assignmentAction: action,
        assignmentTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_bot_assigned`]: result.botAssigned,
          [`node_${input.nodeId}_bot_unassigned`]: result.botUnassigned,
          [`node_${input.nodeId}_assigned_bot_id`]: result.assignedBotId,
          [`node_${input.nodeId}_inbox_id`]: result.inboxId,
          [`node_${input.nodeId}_assignment_action`]: result.assignmentAction,
          [`node_${input.nodeId}_assignment_timestamp`]: result.assignmentTimestamp,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to assign bot', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          botId: input.nodeData.bot_id,
          inboxId: input.nodeData.inbox_id,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}