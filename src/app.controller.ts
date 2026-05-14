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

  @Get('health')
  @Public()
  healthCheck() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  }
}