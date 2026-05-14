import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ProcessingService } from './processing.service';
import { RedisConsumerService } from './consumers/redis.consumer';
import { Public } from 'src/auth/decorators/public.decorator';

@ApiTags('Processing')
@Controller('processing')
export class ProcessingController {
  constructor(
    private readonly processingService: ProcessingService,
    private readonly redisConsumerService: RedisConsumerService,
  ) {}

  @Get('info')
  @Public()
  @ApiOperation({
    summary: 'Get Processing Configuration',
    description:
      'Returns current queue mode, storage mode and processor configuration',
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
            queueMode: { type: 'string', example: 'direct' },
            storageMode: { type: 'string', example: 'postgres' },
          },
        },
        processor: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
  })
  getProcessingInfo() {
    return this.processingService.getProcessingInfo();
  }

  @Get('health')
  @Public()
  @ApiOperation({
    summary: 'Get Processing Health Status',
    description: 'Health check for current processing configuration',
  })
  @ApiResponse({
    status: 200,
    description: 'Processing health status',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['healthy', 'unhealthy'] },
        config: { type: 'object' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  async getHealthStatus() {
    return await this.processingService.getHealthStatus();
  }

  @Get('queue-stats')
  @ApiOperation({
    summary: 'Get Queue Statistics',
    description:
      'Returns queue statistics (Redis queue length, workers status, etc.)',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue statistics',
    schema: {
      type: 'object',
      properties: {
        queueName: { type: 'string' },
        queueLength: { type: 'number' },
        isRunning: { type: 'boolean' },
        workersCount: { type: 'number' },
      },
    },
  })
  async getQueueStats() {
    return await this.redisConsumerService.getQueueStats();
  }

  @Get('atomic-assignments')
  @ApiOperation({
    summary: 'Get Recent Atomic Assignments',
    description: 'Returns recent atomic segment assignments for validation',
  })
  async getAtomicAssignments() {
    // Query recent atomic assignments
    const query = `
      SELECT 
        contact_id,
        computed_property_id,
        segment_value,
        assigned_at
      FROM computed_property_assignments_v2 
      WHERE computed_property_id = 'd2d496bf-b07e-4c59-bd36-57290eb43e62'
      ORDER BY assigned_at DESC 
      LIMIT 10
    `;

    const result = await this.processingService['clickHouseService'].query({
      query,
    });

    return {
      segmentId: 'd2d496bf-b07e-4c59-bd36-57290eb43e62',
      segmentName: 'msg_incoming_35_min',
      recentAssignments: result,
      message: 'Recent atomic assignments for msg_incoming_35_min segment',
    };
  }
}
