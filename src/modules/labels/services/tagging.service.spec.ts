import { TaggingService } from './tagging.service';
import type { ContactsClientService } from '../../../shared/crm-client/contacts-client.service';
import { TaggableType } from '../entities/tagging.entity';

describe('TaggingService (deprecated thin facade)', () => {
  let contactsClient: jest.Mocked<ContactsClientService>;
  let service: TaggingService;

  beforeEach(() => {
    contactsClient = {
      addLabel: jest.fn().mockResolvedValue(undefined),
      removeLabel: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ContactsClientService>;
    service = new TaggingService(contactsClient);
  });

  describe('addTagToEntity', () => {
    it('delegates to ContactsClientService.addLabel for CONTACT/labels', async () => {
      await service.addTagToEntity(
        TaggableType.CONTACT,
        'contact-1',
        'vip',
        'labels',
      );

      expect(contactsClient.addLabel).toHaveBeenCalledWith('contact-1', 'vip');
    });

    it('throws for non-CONTACT taggable types', async () => {
      await expect(
        service.addTagToEntity(
          TaggableType.CONVERSATION,
          'conv-1',
          'vip',
          'labels',
        ),
      ).rejects.toThrow(/only \(CONTACT, 'labels'\) is supported/);
      expect(contactsClient.addLabel).not.toHaveBeenCalled();
    });

    it('throws for non-labels contexts', async () => {
      await expect(
        service.addTagToEntity(
          TaggableType.CONTACT,
          'contact-1',
          'vip',
          'categories',
        ),
      ).rejects.toThrow(/only \(CONTACT, 'labels'\) is supported/);
    });
  });

  describe('removeTagFromEntity', () => {
    it('delegates to ContactsClientService.removeLabel for CONTACT/labels', async () => {
      await service.removeTagFromEntity(
        TaggableType.CONTACT,
        'contact-1',
        'vip',
        'labels',
      );

      expect(contactsClient.removeLabel).toHaveBeenCalledWith(
        'contact-1',
        'vip',
      );
    });

    it('throws for non-CONTACT taggable types', async () => {
      await expect(
        service.removeTagFromEntity(
          TaggableType.CONVERSATION,
          'conv-1',
          'vip',
          'labels',
        ),
      ).rejects.toThrow(/only \(CONTACT, 'labels'\) is supported/);
      expect(contactsClient.removeLabel).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['setTagList', () => service.setTagList(TaggableType.CONTACT, 'x', [])],
    ['getTagList', () => service.getTagList(TaggableType.CONTACT, 'x')],
    ['addTags', () => service.addTags(TaggableType.CONTACT, 'x', [])],
    ['removeTags', () => service.removeTags(TaggableType.CONTACT, 'x', [])],
    [
      'findTaggablesByTags',
      () => service.findTaggablesByTags(TaggableType.CONTACT, []),
    ],
    ['renameTag', () => service.renameTag('a', 'b')],
    ['getMostUsedTags', () => service.getMostUsedTags()],
    ['cleanupUnusedTags', () => service.cleanupUnusedTags()],
  ])('removed method: %s', (name, invoke) => {
    it(`throws a removed-method error for ${name}`, async () => {
      await expect(invoke()).rejects.toThrow(
        new RegExp(`TaggingService\\.${name} removed`),
      );
    });
  });
});
