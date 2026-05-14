import { Injectable } from '@nestjs/common';
import { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import { TaggableType } from '../entities/tagging.entity';

/**
 * @deprecated Use {@link LabelsService} (or {@link ContactsClientService}) directly.
 *
 * Thin facade kept for backward compatibility with consumers that still
 * import `TaggingService`. Labels live in evo-ai-crm-community
 * (Rails acts_as_taggable_on); evo-flow no longer persists tagging state
 * locally, so methods that have no 1:1 CRM mapping now reject with a
 * removed-method error.
 *
 * Mapped methods (CONTACT taggable, `labels` context only):
 *  - addTagToEntity     → ContactsClientService.addLabel
 *  - removeTagFromEntity → ContactsClientService.removeLabel
 *
 * Unmapped methods (no CRM equivalent — kept only to surface a clear error
 * instead of silently breaking callers): setTagList, getTagList, addTags,
 * removeTags, findTaggablesByTags, renameTag, getMostUsedTags,
 * cleanupUnusedTags.
 */
@Injectable()
export class TaggingService {
  constructor(private readonly contactsClient: ContactsClientService) {}

  /**
   * @deprecated Delegates to ContactsClientService.addLabel for CONTACT/labels.
   */
  async addTagToEntity(
    taggableType: TaggableType,
    taggableId: string,
    tagName: string,
    context: string = 'labels',
    taggerId?: string,
  ): Promise<void> {
    void taggerId; // tagger id is owned by the CRM session, not the caller
    this.assertContactLabels(taggableType, context, 'addTagToEntity');
    await this.contactsClient.addLabel(taggableId, tagName);
  }

  /**
   * @deprecated Delegates to ContactsClientService.removeLabel for CONTACT/labels.
   */
  async removeTagFromEntity(
    taggableType: TaggableType,
    taggableId: string,
    tagName: string,
    context: string = 'labels',
  ): Promise<void> {
    this.assertContactLabels(taggableType, context, 'removeTagFromEntity');
    await this.contactsClient.removeLabel(taggableId, tagName);
  }

  /** @deprecated No CRM equivalent — labels are owned by evo-ai-crm-community. */
  setTagList(
    taggableType: TaggableType,
    taggableId: string,
    labelNames: string[],
    context: string = 'labels',
    taggerId?: string,
  ): Promise<string[]> {
    void taggableType;
    void taggableId;
    void labelNames;
    void context;
    void taggerId;
    return Promise.reject(this.removed('setTagList'));
  }

  /** @deprecated No CRM equivalent — read labels via ContactsClientService.findById. */
  getTagList(
    taggableType: TaggableType,
    taggableId: string,
    context: string = 'labels',
  ): Promise<string[]> {
    void taggableType;
    void taggableId;
    void context;
    return Promise.reject(this.removed('getTagList'));
  }

  /** @deprecated No CRM equivalent — call ContactsClientService.addLabel per tag. */
  addTags(
    taggableType: TaggableType,
    taggableId: string,
    labelNames: string[],
    context: string = 'labels',
    taggerId?: string,
  ): Promise<string[]> {
    void taggableType;
    void taggableId;
    void labelNames;
    void context;
    void taggerId;
    return Promise.reject(this.removed('addTags'));
  }

  /** @deprecated No CRM equivalent — call ContactsClientService.removeLabel per tag. */
  removeTags(
    taggableType: TaggableType,
    taggableId: string,
    labelNames: string[],
    context: string = 'labels',
  ): Promise<string[]> {
    void taggableType;
    void taggableId;
    void labelNames;
    void context;
    return Promise.reject(this.removed('removeTags'));
  }

  /** @deprecated No CRM equivalent — search lives in evo-ai-crm-community. */
  findTaggablesByTags(
    taggableType: TaggableType,
    tagNames: string[],
    context: string = 'labels',
  ): Promise<number[]> {
    void taggableType;
    void tagNames;
    void context;
    return Promise.reject(this.removed('findTaggablesByTags'));
  }

  /** @deprecated No CRM equivalent — label management lives in evo-ai-crm-community. */
  renameTag(oldName: string, newName: string): Promise<void> {
    void oldName;
    void newName;
    return Promise.reject(this.removed('renameTag'));
  }

  /** @deprecated No CRM equivalent — analytics live in evo-ai-crm-community. */
  getMostUsedTags(
    taggableType?: TaggableType,
    context: string = 'labels',
    limit: number = 10,
  ): Promise<Array<{ name: string; count: number }>> {
    void taggableType;
    void context;
    void limit;
    return Promise.reject(this.removed('getMostUsedTags'));
  }

  /** @deprecated No CRM equivalent — cleanup happens server-side in evo-ai-crm-community. */
  cleanupUnusedTags(): Promise<void> {
    return Promise.reject(this.removed('cleanupUnusedTags'));
  }

  private assertContactLabels(
    taggableType: TaggableType,
    context: string,
    method: string,
  ): void {
    if (taggableType !== TaggableType.CONTACT || context !== 'labels') {
      throw new Error(
        `TaggingService.${method}: only (CONTACT, 'labels') is supported — labels live in evo-ai-crm-community.`,
      );
    }
  }

  private removed(method: string): Error {
    return new Error(
      `TaggingService.${method} removed — labels live in evo-ai-crm-community. Use ContactsClientService directly.`,
    );
  }
}
