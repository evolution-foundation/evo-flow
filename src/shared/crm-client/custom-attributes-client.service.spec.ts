import { ContactsClientService } from './contacts-client.service';
import { CustomAttributesClientService } from './custom-attributes-client.service';

describe('CustomAttributesClientService', () => {
  it('delegates updateValueForContact to ContactsClientService.updateCustomAttribute', async () => {
    const contacts = {
      updateCustomAttribute: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ContactsClientService>;

    const service = new CustomAttributesClientService(contacts);
    await service.updateValueForContact('abc', 'k', 'v');

    expect(contacts.updateCustomAttribute).toHaveBeenCalledWith(
      'abc',
      'k',
      'v',
      undefined,
    );
  });
});
