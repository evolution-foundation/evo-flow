import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiProcessingService } from './api-processing.service';
import { Public } from 'src/auth/decorators/public.decorator';

@ApiTags('Processing')
@Controller('processing')
export class ApiProcessingController {
  constructor(private readonly processingService: ApiProcessingService) {}

  @Get('info')
  @Public()
  @ApiOperation({
    summary: 'Get Processing Configuration (API Mode)',
    description:
      'Returns current queue mode configuration for API gateway mode',
  })
  @ApiResponse({
    status: 200,
    description: 'Processing configuration retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            runMode: { type: 'string', example: 'api' },
            queueMode: { type: 'string', example: 'kafka' },
            writeMode: { type: 'string', example: 'kafka' },
            description: { type: 'string' },
          },
        },
      },
    },
  })
  async getProcessingInfo() {
    return {
      config: this.processingService.getConfig(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health')
  @Public()
  @ApiOperation({
    summary: 'Check Processing Health (API Mode)',
    description: 'Checks if Kafka producer is healthy in API mode',
  })
  @ApiResponse({
    status: 200,
    description: 'Health check completed successfully',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['healthy', 'unhealthy'] },
        components: {
          type: 'object',
          properties: {
            kafka: { type: 'string', enum: ['healthy', 'unhealthy'] },
          },
        },
      },
    },
  })
  async healthCheck() {
    const isHealthy = await this.processingService.healthCheck();
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      components: {
        kafka: isHealthy ? 'healthy' : 'unhealthy',
      },
      timestamp: new Date().toISOString(),
    };
  }
}