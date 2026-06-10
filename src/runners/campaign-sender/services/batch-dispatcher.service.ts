import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import { TenantDbContext } from '../../../evo-extension-points';
import { CrmInboxDispatcher } from '../../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';
import type { DispatchResult } from '../../../shared/messaging-channels/interfaces/channel-dispatcher.interface';
import type { HydratedContact } from '../../../shared/crm-client/types/contact';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';

export interface BatchDispatchInput {
  campaignId: string;
  inboxId: string;
  template: MessageTemplate;
  contact: HydratedContact;
}

/**
 * Batch-scoped dispatch helper for the campaign-sender (story 4.3 / EVO-1217):
 * loads the batch's MessageTemplate once, renders per-contact content and
 * delegates HTTP delivery to the shared CrmInboxDispatcher (story 2.2). The
 * dispatch path is channel-agnostic — the channel is carried by `inboxId`.
 *
 * Content rendering mirrors the legacy CampaignMessageSenderService
 * placeholder semantics ({contact.name} / {{contact.name}} / custom
 * attributes); the legacy path is removed by story 5.5.
 */
@Injectable()
export class BatchDispatcherService {
  constructor(
    private readonly db: TenantDbContext,
    private readonly crmInboxDispatcher: CrmInboxDispatcher,
  ) {}

  private get messageTemplateRepository(): Repository<MessageTemplate> {
    return this.db.getRepository(MessageTemplate);
  }

  /**
   * Load the batch's template once. A missing template is terminal: every
   * contact in the batch would fail identically, so the whole message is
   * dropped to the DLQ instead of burning one FAILED row per contact.
   */
  async loadTemplate(
    campaignId: string,
    templateId: string,
  ): Promise<MessageTemplate> {
    const template = await this.messageTemplateRepository.findOne({
      where: { id: templateId },
    });
    if (!template) {
      throw new CampaignNotConfiguredError(
        campaignId,
        `message template ${templateId} not found`,
      );
    }
    return template;
  }

  async dispatch(input: BatchDispatchInput): Promise<DispatchResult> {
    const { campaignId, inboxId, template, contact } = input;
    return this.crmInboxDispatcher.dispatch({
      contactId: contact.id,
      inboxId,
      content: this.renderContent(template.content, contact),
      campaignId,
      templateParams: {
        name: template.name,
        category: template.category || undefined,
        language: template.language || 'pt_BR',
        // Entity types `variables` as jsonb array; the legacy sender forwards
        // it verbatim as processed_params, so preserve the wire shape.
        processed_params: (template.variables ?? {}) as unknown as Record<
          string,
          unknown
        >,
      },
    });
  }

  private renderContent(content: string, contact: HydratedContact): string {
    const values: Record<string, string> = {
      'contact.name': contact.name || '',
      'contact.email': contact.email || '',
      'contact.phone': contact.phoneNumber || '',
    };
    for (const [key, value] of Object.entries(contact.customAttributes ?? {})) {
      values[`contact.${key}`] =
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
    }

    let rendered = content;
    for (const [key, value] of Object.entries(values)) {
      // Double-brace form first, otherwise `{key}` would eat the inner braces
      // of `{{key}}` and leave a stray `{...}` around the value.
      rendered = rendered.replaceAll(`{{${key}}}`, value);
      rendered = rendered.replaceAll(`{${key}}`, value);
    }
    return rendered;
  }
}
