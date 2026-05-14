import { Controller, Get, UseGuards } from '@nestjs/common';
import { BearerAuthGuard } from './bearer-auth.guard';
import { CurrentUser, UnifiedUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

@Controller('auth')
export class AuthController {
  @Get('profile')
  @UseGuards(BearerAuthGuard)
  getProfile(@CurrentUser() user: UnifiedUser) {
    return {
      message: 'Authentication successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        scopes: user.scopes,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health')
  @Public()
  healthCheck() {
    return {
      strategy: 'evo-auth',
      evoAuthUrl: process.env.EVO_AUTH_SERVICE_URL || 'http://localhost:3001',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  }
}
