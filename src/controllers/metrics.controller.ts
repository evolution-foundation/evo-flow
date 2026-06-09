import { Controller, Get, Response } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response as ExpressResponse } from 'express';
import { PrometheusMetrics } from '../modules/processing/metrics/prometheus-metrics';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Metrics & Monitoring')
@Controller('metrics')
@Public()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  @ApiOperation({
    summary: 'Prometheus metrics endpoint',
    description: 'Returns metrics in Prometheus format for scraping',
  })
  @ApiResponse({
    status: 200,
    description: 'Metrics data in Prometheus format',
    headers: {
      'Content-Type': {
        description: 'text/plain; version=0.0.4; charset=utf-8',
      },
    },
  })
  async getMetrics(@Response() res: ExpressResponse) {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await this.metrics.getMetrics());
  }

  @Get('health')
  @ApiOperation({
    summary: 'Health metrics summary',
    description: 'Returns summarized health metrics in JSON format',
  })
  @ApiResponse({
    status: 200,
    description: 'Health metrics summary',
  })
  getHealthMetrics() {
    return {
      timestamp: new Date().toISOString(),
      service: 'evo-campaign',
      status: 'healthy',
      metrics: {
        // Add health-specific metrics summary here
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
      },
    };
  }
}
