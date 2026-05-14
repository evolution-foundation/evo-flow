import { Injectable } from '@nestjs/common';
import { ContactsClientService } from './contacts-client.service';
import type { RequestOptions } from './types/responses';

/**
 * CustomAttributesClientService — thin facade over `ContactsClientService`
 * for consumers that only need to update custom attributes on contacts.
 *
 * Kept as a separate service so `CustomAttributesService` (evo-flow) can
 * inject only this without dragging in the full ContactsClientService API.
 */
@Injectable()
export class CustomAttributesClientService {
  constructor(private readonly contacts: ContactsClientService) {}

  async updateValueForContact(
    contactId: string,
    key: string,
    value: unknown,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.contacts.updateCustomAttribute(contactId, key, value, opts);
  }
}
