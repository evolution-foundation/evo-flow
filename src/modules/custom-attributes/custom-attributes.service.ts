import { Injectable } from '@nestjs/common';
import { CustomAttributesClientService } from '../../shared/crm-client/custom-attributes-client.service';

/**
 * Thin CustomAttributesService — delegates to the CRM client.
 *
 * Public API kept to the minimum consumed by temporal nodes and the thin
 * ContactsService. CRUD lives in the CRM Rails service; this facade exists
 * so consumers in evo-flow have a stable injection point.
 *
 * Methods retained (per evo-flow-q3-custom-attributes-service Task 2):
 *  - updateValueForContact(contactId, attrKey, value)
 */
@Injectable()
export class CustomAttributesService {
  constructor(
    private readonly customAttributesClient: CustomAttributesClientService,
  ) {}

  async updateValueForContact(
    contactId: string,
    attrKey: string,
    value: unknown,
  ): Promise<void> {
    return this.customAttributesClient.updateValueForContact(
      contactId,
      attrKey,
      value,
    );
  }
}
