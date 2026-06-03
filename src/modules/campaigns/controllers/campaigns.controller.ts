import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { CampaignsService } from '../services/campaigns.service';
import { AudienceComputationService } from '../../../shared/audience/audience-computation.service';
import { AudienceValidationService } from '../services/audience-validation.service';
import { CampaignWorkflowService } from '../services/campaign-workflow.service';
import { CampaignExecutionsService } from '../services/campaign-executions.service';
import { CreateCampaignDto, UpdateCampaignDto, CampaignQueryDto } from '../dto';
import { Campaign } from '../entities/campaign.entity';
import { CampaignExecutionStatus } from '../entities/campaign-execution.entity';
import { paginatedResponse, successResponse } from '../../../common/utils/response.util';

@ApiTags('Campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly audienceComputationService: AudienceComputationService,
    private readonly audienceValidationService: AudienceValidationService,
    private readonly campaignWorkflowService: CampaignWorkflowService,
    private readonly campaignExecutionsService: CampaignExecutionsService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create Campaign',
    description: 'Create a new campaign',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Campaign created successfully',
    type: Campaign,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Campaign with this name already exists',
  })
  async create(@Body() createCampaignDto: CreateCampaignDto): Promise<Campaign> {
    return await this.campaignsService.create(createCampaignDto);
  }

  @Get()
  @ApiOperation({
    summary: 'List Campaigns',
    description: 'Get all campaigns for the current account with pagination, filtering, and sorting',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaigns retrieved successfully',
  })
  async findAll(@Query() queryDto: CampaignQueryDto) {
    const { campaigns, total, page, pageSize } = await this.campaignsService.findAll(queryDto);

    return paginatedResponse(campaigns, page, pageSize, total);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get Campaign',
    description: 'Get a campaign by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign retrieved successfully',
    type: Campaign,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Campaign not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    return await this.campaignsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update Campaign',
    description: 'Update a campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign updated successfully',
    type: Campaign,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Campaign not found',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCampaignDto: UpdateCampaignDto,
  ): Promise<Campaign> {
    return await this.campaignsService.update(id, updateCampaignDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete Campaign',
    description: 'Soft delete a campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Campaign deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Campaign not found',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return await this.campaignsService.remove(id);
  }

  @Post(':id/schedule')
  @ApiOperation({
    summary: 'Schedule Campaign',
    description: 'Schedule a campaign to start at a specific time',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign scheduled successfully',
    type: Campaign,
  })
  async schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('scheduleTo') scheduleTo: string,
  ): Promise<Campaign> {
    return await this.campaignsService.schedule(id, new Date(scheduleTo));
  }

  @Post(':id/pause')
  @ApiOperation({
    summary: 'Pause Campaign',
    description: 'Pause a running campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign paused successfully',
    type: Campaign,
  })
  async pause(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    const activeExecution = await this.campaignExecutionsService.getActiveExecution(
      id,
    );
    if (!activeExecution) {
      throw new BadRequestException('No active campaign execution to pause');
    }

    await this.campaignWorkflowService.pauseWorkflow(activeExecution.workflowId);

    try {
      const campaign = await this.campaignsService.pause(id);
      await this.campaignExecutionsService.updateStatus(
        activeExecution.id,
        CampaignExecutionStatus.PAUSED,
      );
      return campaign;
    } catch (error) {
      // Best-effort compensation to avoid paused workflow with non-paused campaign.
      try {
        await this.campaignWorkflowService.resumeWorkflow(activeExecution.workflowId);
      } catch (_resumeError) {}
      throw error;
    }
  }

  @Post(':id/resume')
  @ApiOperation({
    summary: 'Resume Campaign',
    description: 'Resume a paused campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign resumed successfully',
    type: Campaign,
  })
  async resume(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    const activeExecution = await this.campaignExecutionsService.getActiveExecution(
      id,
    );
    if (!activeExecution) {
      throw new BadRequestException('No active campaign execution to resume');
    }

    await this.campaignWorkflowService.resumeWorkflow(activeExecution.workflowId);

    try {
      const campaign = await this.campaignsService.resume(id);
      await this.campaignExecutionsService.updateStatus(
        activeExecution.id,
        CampaignExecutionStatus.RUNNING,
      );
      return campaign;
    } catch (error) {
      // Best-effort compensation to avoid running workflow with paused campaign.
      try {
        await this.campaignWorkflowService.pauseWorkflow(activeExecution.workflowId);
      } catch (_pauseError) {}
      throw error;
    }
  }

  @Post(':id/stop')
  @ApiOperation({
    summary: 'Stop Campaign',
    description: 'Stop a running or paused campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign stopped successfully',
    type: Campaign,
  })
  async stop(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    const activeExecution = await this.campaignExecutionsService.getActiveExecution(
      id,
    );
    if (!activeExecution) {
      return await this.campaignsService.stop(id);
    }

    await this.campaignWorkflowService.cancelWorkflow(activeExecution.workflowId);
    const campaign = await this.campaignsService.stop(id);
    await this.campaignExecutionsService.updateStatus(
      activeExecution.id,
      CampaignExecutionStatus.CANCELLED,
    );
    return campaign;
  }

  @Post(':id/duplicate')
  @ApiOperation({
    summary: 'Duplicate Campaign',
    description: 'Create a copy of an existing campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Campaign duplicated successfully',
    type: Campaign,
  })
  async duplicate(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    return await this.campaignsService.duplicate(id);
  }

  @Post('bulk-action')
  @ApiOperation({
    summary: 'Bulk Action on Campaigns',
    description: 'Perform bulk actions (pause, resume, delete) on multiple campaigns',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bulk action completed successfully',
  })
  async bulkAction(
    @Body() body: { action: 'pause' | 'resume' | 'delete'; campaign_ids: string[] },
  ) {
    const result = await this.campaignsService.bulkAction(
      body.action,
      body.campaign_ids,
    );

    return successResponse(result);
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get Campaign Statistics',
    description: 'Get detailed statistics for a campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign statistics retrieved successfully',
  })
  async getStats(@Param('id', ParseUUIDPipe) id: string) {
    const stats = await this.campaignsService.getStats(id);

    return successResponse(stats);
  }

  // ============ AUDIENCE MANAGEMENT ENDPOINTS ============

  @Post(':id/audience/compute')
  @ApiOperation({
    summary: 'Compute Campaign Audience',
    description: 'Execute segmentation and populate campaigns_contacts table with target audience',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience computed successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Campaign not found',
  })
  async computeAudience(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.audienceComputationService.computeAudience(id);

    return successResponse(result);
  }

  @Get(':id/audience/count')
  @ApiOperation({
    summary: 'Get Audience Count',
    description: 'Get the number of contacts in the campaign audience',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience count retrieved successfully',
  })
  async getAudienceCount(@Param('id', ParseUUIDPipe) id: string) {
    const count = await this.audienceComputationService.getAudienceCount(id);

    return successResponse({ count });
  }

  @Get(':id/audience/preview')
  @ApiOperation({
    summary: 'Preview Campaign Audience',
    description: 'Get a preview of contacts that will receive the campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of contacts to preview (default: 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Offset for pagination (default: 0)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience preview retrieved successfully',
  })
  async getAudiencePreview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    const result = await this.audienceComputationService.getAudiencePreview(
      id,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );

    return successResponse(result);
  }

  @Get(':id/audience/estimate')
  @ApiOperation({
    summary: 'Estimate Audience Size',
    description: 'Estimate the size of the campaign audience without computing it',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience size estimated successfully',
  })
  async estimateAudienceSize(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.audienceComputationService.estimateAudienceSize(id);

    return successResponse(result);
  }

  @Post(':id/audience/validate')
  @ApiOperation({
    summary: 'Validate Campaign Audience',
    description: 'Validate the quality of the campaign audience (check for blocked contacts, missing fields, etc.)',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience validated successfully',
  })
  async validateAudience(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.audienceValidationService.validateAudience(id);

    return successResponse(result);
  }

  @Post(':id/audience/validate-before')
  @ApiOperation({
    summary: 'Pre-validate Audience',
    description: 'Validate audience quality before computing (uses a sample)',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiQuery({
    name: 'sample_size',
    required: false,
    type: Number,
    description: 'Number of contacts to sample for validation (default: 100)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Pre-validation completed successfully',
  })
  async validateBeforeComputation(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('sample_size') sampleSize?: number,
  ) {
    const result =
      await this.audienceValidationService.validateBeforeComputation(
        id,
        sampleSize ? Number(sampleSize) : 100,
      );

    return successResponse(result);
  }

  @Delete(':id/audience')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear Campaign Audience',
    description: 'Remove all contacts from the campaign audience',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Audience cleared successfully',
  })
  async clearAudience(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.audienceComputationService.clearAudience(id);

    return successResponse(result);
  }

  @Post(':id/audience/remove-invalid')
  @ApiOperation({
    summary: 'Remove Invalid Contacts',
    description: 'Remove contacts with validation issues from the campaign audience',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Invalid contacts removed successfully',
  })
  async removeInvalidContacts(@Param('id', ParseUUIDPipe) id: string) {
    const result =
      await this.audienceValidationService.removeInvalidContacts(id);

    return successResponse(result);
  }

  // ============ CAMPAIGN EXECUTION ENDPOINTS ============

  @Post(':id/execute')
  @ApiOperation({
    summary: 'Execute Campaign',
    description: 'Start campaign execution immediately via Temporal workflow',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign execution started successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Campaign not found',
  })
  async executeCampaign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    options?: {
      batch_size?: number;
      delay_between_batches?: number;
      skip_audience_computation?: boolean;
    },
  ) {
    // Verify campaign exists
    await this.campaignsService.findOne(id);

    const activeExecution = await this.campaignExecutionsService.getActiveExecution(
      id,
    );
    if (activeExecution) {
      throw new BadRequestException('Campaign already has an active execution');
    }

    // Start workflow execution
    const result = await this.campaignWorkflowService.startCampaignExecution(
      id,
      {
        batchSize: options?.batch_size,
        delayBetweenBatches: options?.delay_between_batches,
        skipAudienceComputation: options?.skip_audience_computation,
      },
    );

    let execution;
    try {
      execution = await this.campaignExecutionsService.createExecution({
        campaignId: id,
        workflowId: result.workflowId,
        runId: result.runId,
        metadata: {
          batch_size: options?.batch_size,
          delay_between_batches: options?.delay_between_batches,
          skip_audience_computation: options?.skip_audience_computation,
        },
      });
    } catch (_error) {
      // Prevent orphan workflow when persistence fails.
      try {
        await this.campaignWorkflowService.cancelWorkflow(result.workflowId);
      } catch (_cancelError) {
        // Ignore compensation failure and throw persistence error.
      }
      throw new ConflictException(
        'Failed to persist campaign execution; workflow start was reverted',
      );
    }

    return successResponse({
      execution_id: execution.id,
      workflow_id: result.workflowId,
      run_id: result.runId,
      message: 'Campaign execution started successfully',
    });
  }

  @Get(':id/execution/status')
  @ApiOperation({
    summary: 'Get Campaign Execution Status',
    description: 'Get the status of a campaign workflow execution',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiQuery({
    name: 'workflow_id',
    required: false,
    type: String,
    description: 'Workflow ID returned from execute endpoint (optional)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Execution status retrieved successfully',
  })
  async getExecutionStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('workflow_id') workflowId?: string,
  ) {
    const execution = await this.campaignExecutionsService.getLatestExecution(
      id,
    );

    if (!execution && !workflowId) {
      return successResponse({
        message: 'No execution found for campaign',
      });
    }

    const resolvedWorkflowId = workflowId || execution?.workflowId;
    const temporalStatus = resolvedWorkflowId
      ? await this.campaignWorkflowService.getWorkflowStatus(resolvedWorkflowId)
      : null;

    return successResponse({
      execution,
      temporal: temporalStatus,
    });
  }

  @Post(':id/execution/cancel')
  @ApiOperation({
    summary: 'Cancel Campaign Execution',
    description: 'Cancel a running campaign workflow',
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Campaign execution cancelled successfully',
  })
  async cancelExecution(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { workflow_id?: string },
  ) {
    const execution = await this.campaignExecutionsService.getActiveExecution(
      id,
    );

    const workflowId = body.workflow_id || execution?.workflowId;
    if (!workflowId) {
      throw new BadRequestException(
        'No active execution found and workflow_id was not provided',
      );
    }

    await this.campaignWorkflowService.cancelWorkflow(workflowId);

    // Also update campaign status to STOPPED
    await this.campaignsService.stop(id);
    if (execution) {
      await this.campaignExecutionsService.updateStatus(
        execution.id,
        CampaignExecutionStatus.CANCELLED,
      );
    }

    return successResponse({
      message: 'Campaign execution cancelled successfully',
    });
  }
}
