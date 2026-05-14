import { UsersService } from './users.service';
import type { AuthClientService } from '../../shared/auth-client/auth-client.service';
import type { UserDto } from '../../shared/auth-client/types/user';

describe('UsersService (thin facade)', () => {
  let authClient: jest.Mocked<AuthClientService>;
  let service: UsersService;

  beforeEach(() => {
    authClient = {
      getUserById: jest.fn(),
    } as unknown as jest.Mocked<AuthClientService>;
    service = new UsersService(authClient);
  });

  describe('findOne', () => {
    it('delegates to AuthClientService.getUserById and returns the UserDto', async () => {
      const expected: UserDto = {
        id: 'user-123',
        name: 'Alice',
        email: 'alice@example.com',
        role: { name: 'admin', permissions: ['read', 'write'] },
      };
      authClient.getUserById.mockResolvedValueOnce(expected);

      const result = await service.findOne('user-123');

      expect(authClient.getUserById).toHaveBeenCalledWith('user-123');
      expect(result).toBe(expected);
    });

    it('returns null when AuthClientService returns null (404 passthrough)', async () => {
      authClient.getUserById.mockResolvedValueOnce(null);

      const result = await service.findOne('missing');

      expect(result).toBeNull();
    });

    it('propagates errors from the auth client (no swallow)', async () => {
      const err = new Error('auth-service unreachable');
      authClient.getUserById.mockRejectedValueOnce(err);

      await expect(service.findOne('user-123')).rejects.toBe(err);
    });
  });
});
