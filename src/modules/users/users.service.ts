import { Injectable } from '@nestjs/common';
import { AuthClientService } from '../../shared/auth-client/auth-client.service';
import type { UserDto } from '../../shared/auth-client/types/user';

/**
 * Thin UsersService — delegates to evo-auth-service via AuthClientService.
 *
 * The CRM Rails does NOT expose `GET /api/v1/users/{id}` (`/api/v1/profiles`
 * only returns `Current.user`), so user lookups go directly to the
 * evo-auth-service-community REST API. See
 * `_evo-output/planning-artifacts/evo-flow-crm-read-path/method-endpoint-mapping.md`
 * §5 for the mapping rationale.
 *
 * Public API (per evo-flow-cleanup Task 5.1):
 *  - findOne(id) → returns UserDto or null (404 → null, no throw).
 */
@Injectable()
export class UsersService {
  constructor(private readonly authClient: AuthClientService) {}

  async findOne(id: string): Promise<UserDto | null> {
    return this.authClient.getUserById(id);
  }
}
