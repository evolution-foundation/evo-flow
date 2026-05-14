import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SegmentModeManagerService } from './services/segment-mode-manager.service';

@ApiTags('Segments Status')
@Controller('segments-status')
export class SegmentsStatusController {
  constructor(private readonly segmentModeManager: SegmentModeManagerService) {}

  @Get()
  @ApiOperation({ summary: 'Get segment system status and configuration' })
  @ApiResponse({
    status: 200,
    description: 'Segment system status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        segmentRunMode: {
          type: 'string',
          enum: ['single', 'api', 'event-worker', 'segment-worker'],
        },
        segmentProcessingMode: {
          type: 'string',
          enum: ['realtime', 'batch', 'scheduled'],
        },
        segmentStorageMode: { type: 'string', enum: ['postgres', 'hybrid'] },
        apiEnabled: { type: 'boolean' },
        processorEnabled: { type: 'boolean' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  getStatus(): Record<string, any> {
    return this.segmentModeManager.getSystemStatus();
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check for segment system' })
  @ApiResponse({
    status: 200,
    description: 'Segment system health status',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
        checks: {
          type: 'object',
          properties: {
            api: { type: 'boolean' },
            processor: { type: 'boolean' },
            database: { type: 'boolean' },
          },
        },
        uptime: { type: 'number' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  getHealth(): Record<string, any> {
    const status = this.segmentModeManager.getSystemStatus();

    return {
      status: 'healthy',
      checks: {
        api: status.apiEnabled,
        processor: status.processorEnabled,
        database: true, // TODO: Add actual database health check
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      configuration: status,
    };
  }
}
