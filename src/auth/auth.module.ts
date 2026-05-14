import { Module, Global } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { EvoAuthStrategy } from './strategies/evo-auth.strategy';
import { BearerAuthGuard } from './bearer-auth.guard';
import { AuthController } from './auth.controller';
import { AuthProxyController } from './auth-proxy.controller';
import { UsersProxyController } from './users-proxy.controller';
import { ProfileProxyController } from './profile-proxy.controller';

@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'evo-auth' })],
  controllers: [
    AuthController,
    AuthProxyController,
    UsersProxyController,
    ProfileProxyController,
  ],
  providers: [EvoAuthStrategy, BearerAuthGuard],
  exports: [PassportModule, BearerAuthGuard],
})
export class AuthModule {}
