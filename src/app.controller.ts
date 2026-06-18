import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  @Get()
  @Public()
  getHello() {
    return {
      message: 'EvoCampaign API',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
    };
  }
}
// NOTE (EVO-1226): the former `GET /health` route moved to HealthController
// (src/health/health.controller.ts), which owns liveness `/health` and
// readiness `/ready` across every RUN_MODE. Keeping it here would collide with
// that controller's bare `@Get('health')` (duplicate route).
