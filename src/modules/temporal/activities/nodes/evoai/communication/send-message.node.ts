import { BaseNode, NodeExecutionResult } from '../../base.node';
import {
  CrmClientService,
  CrmMessageTemplateParams,
} from '../../../../../../shared/crm-client/crm-client.service';

interface CrmMessageTemplate {
  id?: string;
  name?: string;
  content?: string;
  language?: string;
  category?: string;
  variables?: Array<{ name?: string; default_value?: string }>;
}

// EVO-1267: source mapping for one template variable. Root sources become
// {{root.path}} strings resolved by the CRM against the live conversation
// (TemplateVariableResolver); 'fixed' is a literal; 'expression' is a
// template string that may mix several {{root.path}} placeholders.
export interface TemplateVariableMapping {
  variable: string;
  source: 'contact' | 'conversation' | 'pipeline' | 'fixed' | 'expression';
  path?: string;
  value?: string;
  expression?: string;
  fallback?: string;
}

export interface SendMessageNodeInput {
  nodeId: string;
  conversationId?: string; // Optional - will create new conversation if not provided
  sessionId: string;
  contactId?: string; // Add contactId for creating new conversations
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} in the message body via interpolateNodeData
  nodeData: {
    message?: string;
    message_content?: string; // Alternative field name from frontend
    private?: boolean;
    isPrivate?: boolean; // Alternative field name
    inboxId?: string;
    useEventChannel?: boolean;
    nextNodeId?: string;
    // Template mode (EVO-1255). 'text' (default) keeps the legacy free-form
    // behavior; 'template' resolves a CRM message template at execution time.
    messageMode?: 'text' | 'template';
    templateId?: string;
    templateName?: string;
    templateLanguage?: string;
    templateParams?: Record<string, string>;
    // Variable source mappings (EVO-1267); takes precedence over the plain
    // templateParams value for the same variable name.
    templateVariables?: TemplateVariableMapping[];
  };
}

export class SendMessageNode extends BaseNode {
  private crmService: CrmClientService | null = null;

  constructor() {
    super('send-message', 'conversation');
  }

  private getCrmService(): CrmClientService {
    if (!this.crmService) {
      // this.logger.log('Initializing CrmClientService', {
      //   env_EVOAI_CRM_BASE_URL: process.env.EVOAI_CRM_BASE_URL,
      //   env_EVOAI_CRM_API_TOKEN_length: process.env.EVOAI_CRM_API_TOKEN?.length || 0,
      //   hasEnvVars: !!(process.env.EVOAI_CRM_BASE_URL && process.env.EVOAI_CRM_API_TOKEN),
      // });
      this.crmService = new CrmClientService();
    }
    return this.crmService;
  }

  private async getDefaultInbox(): Promise<string | null> {
    try {
      const crmService = this.getCrmService();

      const response = await crmService.getInboxes();

      if (
        !response.success ||
        !response.data ||
        !Array.isArray(response.data)
      ) {
        this.logger.warn('Failed to get inboxes or no inboxes returned', {
          response,
        });
        return null;
      }

      const activeInboxes = response.data.filter((inbox: any) => {
        return (
          inbox &&
          inbox.id &&
          inbox.channel_type &&
          [
            'Channel::Api',
            'Channel::WebWidget',
            'Channel::Whatsapp',
            'Channel::Email',
          ].includes(inbox.channel_type)
        );
      });

      if (activeInboxes.length === 0) {
        this.logger.warn('No suitable inboxes found', {
          totalInboxes: response.data.length,
        });
        return null;
      }

      const defaultInbox = activeInboxes[0];

      return defaultInbox.id.toString();
    } catch (error) {
      this.logger.error('Error getting default inbox', {
        error: error.message,
      });
      return null;
    }
  }

  private async resolveTemplate(
    inboxId: string,
    templateId: string,
  ): Promise<CrmMessageTemplate | null> {
    if (!inboxId || !templateId) return null;

    const response =
      await this.getCrmService().getInboxMessageTemplates(inboxId);
    if (!response.success) return null;

    const raw = response.data;
    const list = Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw)
        ? raw
        : [];
    return (
      (list as CrmMessageTemplate[]).find(
        (template) => String(template.id) === templateId,
      ) ?? null
    );
  }

  // EVO-1267: folds variable source mappings into the processed_params dict.
  // Root sources and expressions stay as {{root.path}} strings — the CRM
  // resolves them against the conversation, where contact/conversation/
  // pipeline data actually lives. Fixed values are literals.
  private buildVariableParams(
    nodeData: SendMessageNodeInput['nodeData'],
  ): { params: Record<string, string>; fallbacks: Record<string, string> } {
    const params: Record<string, string> = {
      ...(nodeData.templateParams ?? {}),
    };
    const fallbacks: Record<string, string> = {};

    for (const mapping of nodeData.templateVariables ?? []) {
      if (!mapping?.variable) continue;

      switch (mapping.source) {
        case 'fixed':
          params[mapping.variable] = mapping.value ?? '';
          break;
        case 'expression':
          params[mapping.variable] = mapping.expression ?? '';
          break;
        case 'contact':
        case 'conversation':
        case 'pipeline':
          if (mapping.path) {
            params[mapping.variable] = `{{${mapping.source}.${mapping.path}}}`;
          }
          break;
        default:
          break;
      }

      if (mapping.fallback) {
        fallbacks[mapping.variable] = mapping.fallback;
      }
    }

    return { params, fallbacks };
  }

  private renderTemplate(
    template: CrmMessageTemplate,
    params: Record<string, string>,
  ): string {
    const defaults = new Map(
      (template.variables ?? []).map((variable) => [
        variable.name,
        variable.default_value ?? '',
      ]),
    );
    // Same {{name}} placeholder format the CRM extracts into `variables`.
    return (template.content ?? '').replace(
      /\{\{\s*([\w.]+)\s*\}\}/g,
      (match, name: string) => params[name] ?? defaults.get(name) ?? match,
    );
  }

  async execute(input: SendMessageNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Log all input data for debugging
      // this.logger.log('Send Message Node - Complete Input Debug', {
      //   nodeId: input.nodeId,
      //   contactId: input.contactId,
      //   conversationId: input.conversationId,
      //
      //   sessionId: input.sessionId,
      //   nodeData: input.nodeData,
      //   nodeDataKeys: Object.keys(input.nodeData || {}),
      // });

      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      // this.logger.log('Send Message Node - Interpolated Data Debug', {
      //   nodeId: input.nodeId,
      //   interpolatedNodeData,
      //   interpolatedKeys: Object.keys(interpolatedNodeData || {}),
      // });

      const isTemplateMode = interpolatedNodeData.messageMode === 'template';

      if (isTemplateMode && !interpolatedNodeData.templateId) {
        this.logger.warn('Template mode without templateId; skipping', {
          nodeId: input.nodeId,
        });
        return {
          messageSent: false,
          skipped: true,
          reason: 'no_template_id',
          sendTimestamp: new Date().toISOString(),
        };
      }

      // Extract message content (support both field names)
      let messageContent =
        interpolatedNodeData.message || interpolatedNodeData.message_content;

      // If no message configured, use a default message
      if (
        !isTemplateMode &&
        (!messageContent || messageContent.trim() === '')
      ) {
        messageContent = 'Olá! Esta é uma mensagem automática da sua jornada.';
        this.logger.log('No message configured, using default message', {
          nodeId: input.nodeId,
          defaultMessage: messageContent,
        });
      }

      // Extract private flag (support both field names)
      const isPrivate =
        interpolatedNodeData.private || interpolatedNodeData.isPrivate || false;

      let conversationId = input.conversationId;
      let createdNewConversation = false;

      // If no conversationId from event, cannot proceed
      if (!conversationId) {
        this.logger.warn('No conversationId available from trigger event', {
          nodeId: input.nodeId,
        });

        return {
          messageSent: false,
          messageId: null,
          conversationId: null,
          messageContent: messageContent,
          isPrivate,
          createdNewConversation: false,
          sendTimestamp: new Date().toISOString(),
          crmResponse: {
            error: 'No conversationId available from trigger event',
          },
          skipped: true,
          reason: 'no_conversation_id',
        };
      }

      // this.logger.log('Using conversation ID from trigger event', {
      //   conversationId,
      //
      //   nodeId: input.nodeId,
      // });

      // Send message to existing conversation
      // Prepare conversation context for existing conversation
      const context = {
        conversationId,
      };

      let templateParams: CrmMessageTemplateParams | undefined;
      let templateId: string | undefined;

      if (isTemplateMode) {
        const template = await this.resolveTemplate(
          String(interpolatedNodeData.inboxId ?? ''),
          String(interpolatedNodeData.templateId),
        );

        // A deleted/deactivated template skips the node (logged) instead of
        // failing the journey or silently sending the wrong content.
        if (!template || !template.content) {
          this.logger.warn('Message template not found; skipping send', {
            nodeId: input.nodeId,
            templateId: interpolatedNodeData.templateId,
            inboxId: interpolatedNodeData.inboxId,
          });
          return {
            messageSent: false,
            skipped: true,
            reason: 'template_not_found',
            templateId: interpolatedNodeData.templateId,
            sendTimestamp: new Date().toISOString(),
          };
        }

        const { params, fallbacks } =
          this.buildVariableParams(interpolatedNodeData);
        messageContent = this.renderTemplate(template, params);
        templateId = template.id;
        // The CRM re-renders server-side for channel-bound templates
        // (WhatsApp Cloud sends the real Meta template); for global templates
        // the lookup misses and our rendered content stands. Known degraded
        // path (EVO-1267): when the lookup misses, mapped {{root.path}}
        // values stay raw in the content — the CRM's native Liquid pass
        // covers contact/conversation roots but renders pipeline paths empty
        // and variable_fallbacks do not apply.
        templateParams = {
          name:
            template.name ?? String(interpolatedNodeData.templateName ?? ''),
          language: template.language ?? interpolatedNodeData.templateLanguage,
          category: template.category,
          processed_params: params,
          ...(Object.keys(fallbacks).length > 0
            ? { variable_fallbacks: fallbacks }
            : {}),
        };
      }

      // Execute message sending via CRM API
      const crmService = this.getCrmService();
      const response = await crmService.sendMessage(
        context,
        (messageContent ?? '').trim(),
        isPrivate,
        'send-message',
        templateParams,
      );

      if (!response.success) {
        throw new Error(`Failed to send message: ${response.error}`);
      }

      return {
        messageSent: true,
        messageId: response.data?.id,
        conversationId,
        messageContent: messageContent,
        templateId,
        isPrivate,
        createdNewConversation: false,
        sendTimestamp: new Date().toISOString(),
        crmResponse: response.data,
      };
    })
      .then(({ result, executionTime }) => {
        if (result?.skipped) {
          return this.createSkippedResult(result.reason, executionTime);
        }
        const successResult = this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_message_sent`]: result.messageSent,
          [`node_${input.nodeId}_message_id`]: result.messageId,
          [`node_${input.nodeId}_send_timestamp`]: result.sendTimestamp,
          [`node_${input.nodeId}_is_private`]: result.isPrivate,
          [`node_${input.nodeId}_template_id`]: result.templateId,
        });

        // this.logger.log('🔍 DEBUG: Send Message Node result before return', {
        //   nodeId: input.nodeId,
        //   success: successResult.success,
        //   nextNodeId: successResult.nextNodeId,
        //   nodeDataNextNodeId: input.nodeData?.nextNodeId,
        //   nodeType: this.nodeType,
        //   shouldForceNextNode: ['exit-journey-node', 'transfer-journey-node', 'conditional-node', 'wait-node'].includes(this.nodeType),
        // });

        return successResult;
      })
      .catch((error) => {
        const executionTime = Date.now();
        this.logger.error('Failed to send message', {
          conversationId: input.conversationId,
          nodeId: input.nodeId,
          error: error.message,
        });
        return this.createErrorResult(error, executionTime);
      });
  }
}
