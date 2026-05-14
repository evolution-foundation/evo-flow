import { ContactsService } from './contacts.service';
import type { ContactsClientService } from '../../shared/crm-client/contacts-client.service';

describe('ContactsService (thin facade)', () => {
  let client: jest.Mocked<ContactsClientService>;
  let service: ContactsService;

  beforeEach(() => {
    client = {
      findById: jest.fn(),
      addLabel: jest.fn(),
      removeLabel: jest.fn(),
      updateCustomAttribute: jest.fn(),
    } as unknown as jest.Mocked<ContactsClientService>;
    service = new ContactsService(client);
  });

  describe('findById', () => {
    it('delegates to ContactsClientService.findById and returns the result', async () => {
      const expected = { id: 'abc', name: 'Test' } as any;
      client.findById.mockResolvedValueOnce(expected);

      const result = await service.findById('abc');

      expect(client.findById).toHaveBeenCalledWith('abc');
      expect(result).toBe(expected);
    });

    it('returns null when client returns null (404 passthrough)', async () => {
      client.findById.mockResolvedValueOnce(null);

      const result = await service.findById('missing');

      expect(result).toBeNull();
    });

    it('propagates errors from the client (no swallow)', async () => {
      const err = new Error('boom');
      client.findById.mockRejectedValueOnce(err);

      await expect(service.findById('abc')).rejects.toBe(err);
    });
  });

  describe('addLabel', () => {
    it('delegates to ContactsClientService.addLabel with (contactId, labelId)', async () => {
      client.addLabel.mockResolvedValueOnce(undefined);

      await service.addLabel('abc', 'vip');

      expect(client.addLabel).toHaveBeenCalledWith('abc', 'vip');
    });
  });

  describe('removeLabel', () => {
    it('delegates to ContactsClientService.removeLabel with (contactId, labelId)', async () => {
      client.removeLabel.mockResolvedValueOnce(undefined);

      await service.removeLabel('abc', 'vip');

      expect(client.removeLabel).toHaveBeenCalledWith('abc', 'vip');
    });
  });

  describe('updateCustomAttribute', () => {
    it('delegates to ContactsClientService.updateCustomAttribute with (contactId, key, value)', async () => {
      client.updateCustomAttribute.mockResolvedValueOnce(undefined);

      await service.updateCustomAttribute(
        'abc',
        'last_purchase_at',
        '2026-05-14',
      );

      expect(client.updateCustomAttribute).toHaveBeenCalledWith(
        'abc',
        'last_purchase_at',
        '2026-05-14',
      );
    });

    it('passes complex value types through unchanged', async () => {
      client.updateCustomAttribute.mockResolvedValueOnce(undefined);
      const value = { nested: { foo: 1 } };

      await service.updateCustomAttribute('abc', 'meta', value);

      expect(client.updateCustomAttribute).toHaveBeenCalledWith(
        'abc',
        'meta',
        value,
      );
    });
  });
});
