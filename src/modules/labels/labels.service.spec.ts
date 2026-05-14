import { LabelsService } from './labels.service';
import type { ContactsClientService } from '../../shared/crm-client/contacts-client.service';

describe('LabelsService (thin facade)', () => {
  let contactsClient: jest.Mocked<ContactsClientService>;
  let service: LabelsService;

  beforeEach(() => {
    contactsClient = {
      addLabel: jest.fn().mockResolvedValue(undefined),
      removeLabel: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ContactsClientService>;
    service = new LabelsService(contactsClient);
  });

  describe('addLabel', () => {
    it('delegates to ContactsClientService.addLabel with the same args', async () => {
      await service.addLabel('abc', 'vip');

      expect(contactsClient.addLabel).toHaveBeenCalledTimes(1);
      expect(contactsClient.addLabel).toHaveBeenCalledWith('abc', 'vip');
    });

    it('returns void (resolves) when the client resolves', async () => {
      await expect(service.addLabel('abc', 'vip')).resolves.toBeUndefined();
    });

    it('propagates errors from the client', async () => {
      contactsClient.addLabel.mockRejectedValueOnce(new Error('boom'));

      await expect(service.addLabel('abc', 'vip')).rejects.toThrow('boom');
    });
  });

  describe('removeLabel', () => {
    it('delegates to ContactsClientService.removeLabel with the same args', async () => {
      await service.removeLabel('abc', 'vip');

      expect(contactsClient.removeLabel).toHaveBeenCalledTimes(1);
      expect(contactsClient.removeLabel).toHaveBeenCalledWith('abc', 'vip');
    });

    it('returns void (resolves) when the client resolves', async () => {
      await expect(service.removeLabel('abc', 'vip')).resolves.toBeUndefined();
    });

    it('propagates errors from the client', async () => {
      contactsClient.removeLabel.mockRejectedValueOnce(new Error('nope'));

      await expect(service.removeLabel('abc', 'vip')).rejects.toThrow('nope');
    });
  });
});
