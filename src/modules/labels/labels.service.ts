import { Injectable } from '@nestjs/common';
import { ContactsClientService } from '../../shared/crm-client/contacts-client.service';

/**
 * Thin LabelsService — facade over ContactsClientService.
 *
 * Labels are owned by evo-ai-crm-community (Rails acts_as_taggable_on).
 * There is no local persistence: every call delegates to the CRM REST client.
 *
 * Public API retained for backward compatibility with temporal nodes
 * (add-label.node / remove-label.node) and ContactsService:
 *  - addLabel(contactId, labelId)
 *  - removeLabel(contactId, labelId)
 *
 * The `labelId` argument is forwarded as-is. The CRM client accepts either
 * a label title or a label id (the remove path matches on both); add semantics
 * follow the parent spec's 1:1 delegation contract.
 */
@Injectable()
export class LabelsService {
  constructor(private readonly contactsClient: ContactsClientService) {}

  async addLabel(contactId: string, labelId: string): Promise<void> {
    return this.contactsClient.addLabel(contactId, labelId);
  }

  async removeLabel(contactId: string, labelId: string): Promise<void> {
    return this.contactsClient.removeLabel(contactId, labelId);
  }
}
