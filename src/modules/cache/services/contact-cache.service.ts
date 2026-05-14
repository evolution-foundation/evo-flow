import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseClientCacheService } from './base-client-cache.service';
import { CacheConfig } from '../interfaces/cache.interfaces';
import { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import type {
  ContactDto,
  HydratedContact,
} from '../../../shared/crm-client/types/contact';
import { mapContactDto } from '../../../shared/crm-client/types/contact';

/**
 * Cached representation of a contact. Mirrors the in-memory `HydratedContact`
 * shape (camelCase) while satisfying the `CachedEntity` contract used by the
 * cache layer (id / createdAt / updatedAt / lastCached).
 *
 * Note: CRM Rails does not return `updatedAt` for contacts on the public
 * `/api/v1/contacts/{id}` endpoint, so it falls back to `createdAt` (or
 * `now()` if absent). Consumers that need authoritative `updatedAt` should
 * query the CRM directly.
 */
export interface CachedContact extends HydratedContact {
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
}

@Injectable()
export class ContactCacheService extends BaseClientCacheService<
  ContactDto,
  CachedContact
> {
  constructor(
    private readonly contactsClient: ContactsClientService,
    eventEmitter: EventEmitter2,
  ) {
    const cacheConfig: CacheConfig = {
      redisKeyPrefix: 'evo-campaign:contact',
      memoryMaxSize: 5000,
      memoryTtlMs: 45 * 60 * 1000,
      redisTtlSeconds: 6 * 60 * 60,
      enableL2Cache: false,
      enableStats: true,
    };

    super(eventEmitter, cacheConfig, ContactCacheService.name);
  }

  async getContactByEmail(email: string): Promise<CachedContact | null> {
    // No bulk index in CRM — caller must already know the id. Returning null
    // by default keeps the public surface intact for legacy callers without
    // implying a hot lookup that no longer exists.
    void email;
    return null;
  }

  async getContactByPhone(phone: string): Promise<CachedContact | null> {
    void phone;
    return null;
  }

  async getContactByIdentifier(
    identifier: string,
  ): Promise<CachedContact | null> {
    void identifier;
    return null;
  }

  protected getEntityName(): string {
    return 'Contact';
  }

  protected mapUpstream(dto: ContactDto): CachedContact {
    const hydrated = mapContactDto(dto)!;
    const createdAt = hydrated.createdAt ?? new Date();
    return {
      ...hydrated,
      createdAt,
      updatedAt: createdAt,
      lastCached: new Date(),
    };
  }

  protected async fetchFromUpstream(id: string): Promise<ContactDto | null> {
    return this.contactsClient.findById(id);
  }

  protected async fetchMultipleFromUpstream(
    ids: string[],
  ): Promise<ContactDto[]> {
    return this.contactsClient.findByIds(ids);
  }
}
