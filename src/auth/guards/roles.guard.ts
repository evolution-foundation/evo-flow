import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Role } from '../enums/roles.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * RolesGuard validates the user's role against the required roles declared
 * via `@Roles()` decorator. Single-account mode: no UserAccount lookup, role
 * comes from the validated token payload (request.user.role).
 *
 * Expected shape of request.user (populated by BearerAuthGuard from
 * evo-auth-service validate response):
 *   { id, email, name, role: { name: string, permissions?: string[] } | string }
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly cls: ClsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.get<boolean>(
      'isPublic',
      context.getHandler(),
    );
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || !requiredRoles.length) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return false;

    const roleName: string | undefined =
      typeof user.role === 'string'
        ? user.role
        : (user.role?.name as string | undefined);

    if (!roleName) return false;

    this.cls.set('role', roleName);

    return requiredRoles.includes(roleName as Role);
  }
}
