import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  SegmentDistributedJobService,
  BatchJobRequest,
} from './services/segment-distributed-job.service';
import { SegmentSchedulerService } from './services/segment-scheduler.service';
import { SegmentComputationConsumer } from './consumers/segment-computation.consumer';
import { SegmentResultsConsumer } from './consumers/segment-results.consumer';
import { SegmentJobPriority } from './config/kafka-topics.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@ApiTags('Distributed Segment Processing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('segments/distributed')
export class SegmentsDistributedController {
  private readonly logger = new CustomLoggerService(
    SegmentsDistributedController.name,
  );

  constructor(
    private readonly jobService: SegmentDistributedJobService,
    private readonly schedulerService: SegmentSchedulerService,
    private readonly computationConsumer: SegmentComputationConsumer,
    private readonly resultsConsumer: SegmentResultsConsumer,
  ) {}

  @Post('jobs/batch')
  @ApiOperation({ summary: 'Create a batch of segment computation jobs' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Batch jobs created successfully',
  })
  async createBatchJobs(@Body() request: BatchJobRequest) {
    this.logger.log(
      `Creating batch job with ${request.segments.length} segments`,
    );

    const jobs = await this.jobService.createBatchJobs(request);

    return {
      success: true,
      data: {
        batchId: request.batchId,
        jobCount: jobs.length,
        jobs: jobs.map((job) => ({
          id: job.id,
          segmentId: job.segmentId,
          priority: job.priority,
          status: job.status,
          createdAt: job.createdAt,
        })),
      },
    };
  }

  @Post('schedule')
  @ApiOperation({ summary: 'Schedule recurring segment computation jobs' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Scheduled job created successfully',
  })
  async createScheduledJob(
    @Body()
    request: {
      segmentIds: string[];
      cronExpression: string;
      priority?: SegmentJobPriority;
      metadata: {
        name: string;
        description?: string;
        createdBy: string;
      };
    },
  ) {
    const job = await this.schedulerService.createScheduledJob(
      request.segmentIds,
      request.cronExpression,
      request.priority || SegmentJobPriority.NORMAL,
      {
        ...request.metadata,
        source: 'api',
      },
    );

    return {
      success: true,
      data: job,
    };
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Get scheduled jobs' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled jobs retrieved successfully',
  })
  async getScheduledJobs() {
    const jobs = this.schedulerService.getScheduledJobs();

    return {
      success: true,
      data: jobs,
    };
  }

  @Put('schedule/:jobId')
  @ApiOperation({ summary: 'Update a scheduled job' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled job updated successfully',
  })
  async updateScheduledJob(
    @Param('jobId') jobId: string,
    @Body()
    updates: {
      cronExpression?: string;
      priority?: SegmentJobPriority;
      isActive?: boolean;
      segmentIds?: string[];
    },
  ) {
    const job = await this.schedulerService.updateScheduledJob(jobId, updates);

    if (!job) {
      return {
        success: false,
        error: 'Scheduled job not found',
      };
    }

    return {
      success: true,
      data: job,
    };
  }

  @Delete('schedule/:jobId')
  @ApiOperation({ summary: 'Delete a scheduled job' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled job deleted successfully',
  })
  async deleteScheduledJob(@Param('jobId') jobId: string) {
    const deleted = await this.schedulerService.deleteScheduledJob(jobId);

    return {
      success: deleted,
      message: deleted ? 'Scheduled job deleted' : 'Scheduled job not found',
    };
  }

  @Post('schedule/:jobId/trigger')
  @ApiOperation({ summary: 'Manually trigger a scheduled job' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled job triggered successfully',
  })
  async triggerScheduledJob(@Param('jobId') jobId: string) {
    const triggered = await this.schedulerService.triggerScheduledJob(jobId);

    return {
      success: triggered,
      message: triggered
        ? 'Scheduled job triggered'
        : 'Failed to trigger scheduled job',
    };
  }

  @Get('results')
  @ApiOperation({ summary: 'Get recent computation results' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Results retrieved successfully',
  })
  async getRecentResults(@Query('limit') limit?: number) {
    const results = this.resultsConsumer.getRecentResults(
      limit ? parseInt(limit.toString()) : 10,
    );

    return {
      success: true,
      data: results,
    };
  }

  @Get('results/job/:jobId')
  @ApiOperation({ summary: 'Get result for a specific job' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Job result retrieved successfully',
  })
  async getJobResult(@Param('jobId') jobId: string) {
    const result = this.resultsConsumer.getResultByJobId(jobId);

    if (!result) {
      return {
        success: false,
        error: 'Job result not found',
      };
    }

    return {
      success: true,
      data: result,
    };
  }

  @Get('stats/scheduler')
  @ApiOperation({ summary: 'Get scheduler statistics' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduler stats retrieved successfully',
  })
  async getSchedulerStats() {
    const stats = await this.schedulerService.getSchedulerStats();

    return {
      success: true,
      data: stats,
    };
  }

  @Get('health')
  @ApiOperation({ summary: 'Get distributed processing health status' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Health status retrieved successfully',
  })
  async getHealthStatus() {
    const computationHealth = this.computationConsumer.getHealthStatus();
    const resultsHealth = this.resultsConsumer.getHealthStatus();
    const schedulerStats = await this.schedulerService.getSchedulerStats();

    return {
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        consumers: {
          computation: computationHealth,
          results: resultsHealth,
        },
        scheduler: {
          totalJobs: schedulerStats.totalJobs,
          activeJobs: schedulerStats.activeJobs,
          autoScaling: schedulerStats.autoScaling,
        },
        overall: {
          status:
            computationHealth.isRunning && resultsHealth.isRunning
              ? 'healthy'
              : 'degraded',
        },
      },
    };
  }

  @Get('metrics/consumers')
  @ApiOperation({ summary: 'Get consumer metrics' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Consumer metrics retrieved successfully',
  })
  async getConsumerMetrics() {
    const computationMetrics =
      await this.computationConsumer.getConsumerMetrics();

    return {
      success: true,
      data: {
        computation: computationMetrics,
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post('admin/scale')
  @ApiOperation({ summary: 'Manually trigger scaling action (admin only)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scaling triggered successfully',
  })
  async triggerScaling(
    @Body() request: { action: 'up' | 'down'; count?: number },
  ) {
    // This would typically require admin privileges
    // For now, just return success with the request

    this.logger.log(
      `Manual scaling requested: ${request.action} by ${request.count || 1}`,
    );

    return {
      success: true,
      message: `Scaling ${request.action} request acknowledged`,
      data: request,
    };
  }
}
