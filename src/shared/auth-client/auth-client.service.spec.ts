/**
 * Unit tests for AuthClientService.
 * Mocks axios via jest.mock.
 */
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

process.env.EVO_AUTH_SERVICE_URL = 'http://auth-test.local';
process.env.EVO_AUTH_API_TOKEN = 'auth-svc-token';

jest.mock('axios');
import axios from 'axios';

import { AuthClientService } from './auth-client.service';

describe('AuthClientService', () => {
  let service: AuthClientService;
  let getMock: jest.Mock;

  beforeEach(() => {
    AuthClientService.clearCacheForTests();
    AuthClientService.resetCircuitBreakerForTests();

    getMock = jest.fn();
    (axios as any).create = jest.fn().mockReturnValue({ get: getMock });
    (axios as any).isAxiosError = jest.fn().mockReturnValue(false);

    service = new AuthClientService();
  });

  it('returns UserDto on 200', async () => {
    getMock.mockResolvedValueOnce({
      status: 200,
      data: { id: 'u1', name: 'Alice', email: 'a@b.c' },
    });

    const result = await service.getUserById('u1');
    expect(result).toEqual({ id: 'u1', name: 'Alice', email: 'a@b.c' });
    expect(getMock).toHaveBeenCalledWith(
      '/api/v1/users/u1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer auth-svc-token',
        }),
      }),
    );
  });

  it('unwraps { data: ... } when service wraps response', async () => {
    getMock.mockResolvedValueOnce({
      status: 200,
      data: { data: { id: 'u2', name: 'Bob', email: 'b@x.y' } },
    });

    const result = await service.getUserById('u2');
    expect(result).toEqual({ id: 'u2', name: 'Bob', email: 'b@x.y' });
  });

  it('returns null on 404', async () => {
    getMock.mockResolvedValueOnce({ status: 404, data: {} });
    const result = await service.getUserById('missing');
    expect(result).toBeNull();
  });

  it('throws UnauthorizedException on 401', async () => {
    getMock.mockResolvedValueOnce({ status: 401, data: {} });
    await expect(service.getUserById('u1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws ServiceUnavailableException on 5xx', async () => {
    getMock.mockResolvedValue({ status: 500, data: {} });
    await expect(service.getUserById('u1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('caches GET on success', async () => {
    getMock.mockResolvedValueOnce({
      status: 200,
      data: { id: 'u1', name: 'A', email: 'a@b.c' },
    });

    await service.getUserById('u1');
    await service.getUserById('u1');

    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
