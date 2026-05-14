import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * Thin UsersModule. CRUD scaffolding removed (evo-flow-cleanup); user data
 * is sourced from evo-auth-service via AuthClientService (provided globally
 * by `AuthClientModule`).
 */
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
