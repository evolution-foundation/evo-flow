import { CustomAttributesClientService } from '../../shared/crm-client/custom-attributes-client.service';
import { CustomAttributesService } from './custom-attributes.service';

describe('CustomAttributesService', () => {
  function build() {
    const client = {
      updateValueForContact: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CustomAttributesClientService>;
    const service = new CustomAttributesService(client);
    return { service, client };
  }

  describe('updateValueForContact', () => {
    it('delegates to CustomAttributesClientService.updateValueForContact (happy path)', async () => {
      const { service, client } = build();

      await service.updateValueForContact(
        'abc',
        'last_purchase_at',
        '2026-05-14',
      );

      expect(client.updateValueForContact).toHaveBeenCalledTimes(1);
      expect(client.updateValueForContact).toHaveBeenCalledWith(
        'abc',
        'last_purchase_at',
        '2026-05-14',
      );
    });

    it('propagates errors from the client (e.g. 404 not found)', async () => {
      const { service, client } = build();
      const error = new Error('Contact abc not found');
      (client.updateValueForContact as jest.Mock).mockRejectedValueOnce(error);

      await expect(
        service.updateValueForContact('abc', 'k', 'v'),
      ).rejects.toThrow('Contact abc not found');
    });

    it('propagates generic errors from the client', async () => {
      const { service, client } = build();
      (client.updateValueForContact as jest.Mock).mockRejectedValueOnce(
        new Error('boom'),
      );

      await expect(
        service.updateValueForContact('abc', 'k', 'v'),
      ).rejects.toThrow('boom');
    });
  });
});
