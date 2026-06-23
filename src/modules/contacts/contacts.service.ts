import { Injectable, Logger } from '@nestjs/common';
import { ContactsClientService } from '../../shared/crm-client/contacts-client.service';
import type { ContactDto } from '../../shared/crm-client/types/contact';

/**
 * Thin ContactsService — facade over `ContactsClientService` (CRM Rails).
 *
 * Public API kept to the minimum consumed by temporal nodes and internal
 * orchestration. All persistence/state lives in the CRM; this service does
 * passthrough delegation only — no local cache, no retry, no domain logic.
 *
 * Methods retained (per evo-flow-cleanup Task 4.1 + Q3 read-path wiring):
 *  - findById(id)
 *  - addLabel(contactId, labelId)
 *  - removeLabel(contactId, labelId)
 *  - updateCustomAttribute(contactId, attrKey, value)
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(private readonly contactsClient: ContactsClientService) {}

  async findById(id: string): Promise<ContactDto | null> {
    this.logger.debug(`findById(${id})`);
    return this.contactsClient.findById(id);
  }

  async addLabel(contactId: string, labelId: string): Promise<void> {
    this.logger.debug(`addLabel(${contactId}, ${labelId})`);
    await this.contactsClient.addLabel(contactId, labelId);
  }

  async removeLabel(contactId: string, labelId: string): Promise<void> {
    this.logger.debug(`removeLabel(${contactId}, ${labelId})`);
    await this.contactsClient.removeLabel(contactId, labelId);
  }

  async updateCustomAttribute(
    contactId: string,
    attrKey: string,
    value: unknown,
  ): Promise<void> {
    this.logger.debug(`updateCustomAttribute(${contactId}, ${attrKey}, ...)`);
    await this.contactsClient.updateCustomAttribute(contactId, attrKey, value);
  }

  /**
   * Persist the full custom_attributes map (read-modify-write; the CRM PATCH
   * replaces the column wholesale — EVO-1850).
   */
  async setCustomAttributes(
    contactId: string,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    this.logger.debug(`setCustomAttributes(${contactId}, ...)`);
    await this.contactsClient.setCustomAttributes(contactId, attributes);
  }
}
