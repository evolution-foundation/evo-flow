import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { EvoAuthUser } from '../strategies/evo-auth.strategy';

export interface UnifiedUser extends EvoAuthUser {
  // Kept as alias for compatibility with existing imports.
}

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): UnifiedUser => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new Error(
        'User not found in request. Make sure @UseGuards(BearerAuthGuard) is applied.',
      );
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      scopes: user.scopes,
    };
  },
);
