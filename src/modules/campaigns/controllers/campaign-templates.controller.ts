import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { CampaignTemplatesService } from '../services/campaign-templates.service';
import { TemplateReplicationService } from '../services/template-replication.service';
import { CreateCampaignTemplateDto } from '../dto';
import { CampaignTemplate } from '../entities/campaign-template.entity';

@ApiTags('Campaign Templates')
@Controller('campaigns/:campaignId/templates')
export class CampaignTemplatesController {
  constructor(
    private readonly campaignTemplatesService: CampaignTemplatesService,
    private readonly templateReplicationService: TemplateReplicationService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Add Template to Campaign',
    description: 'Add a message template to a campaign',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Template added to campaign successfully',
    type: CampaignTemplate,
  })
  async create(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() createTemplateDto: CreateCampaignTemplateDto,
  ): Promise<CampaignTemplate> {
    return await this.campaignTemplatesService.create(
      campaignId,
      createTemplateDto,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List Campaign Templates',
    description: 'Get all templates for a campaign',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Templates retrieved successfully',
    type: [CampaignTemplate],
  })
  async findAll(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignTemplate[]> {
    return await this.campaignTemplatesService.findAll(campaignId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get Campaign Template',
    description: 'Get a campaign template by ID',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign Template UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Template retrieved successfully',
    type: CampaignTemplate,
  })
  async findOne(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignTemplate> {
    return await this.campaignTemplatesService.findOne(id, campaignId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove Template from Campaign',
    description: 'Remove a template from a campaign',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign Template UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Template removed successfully',
  })
  async remove(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return await this.campaignTemplatesService.remove(id, campaignId);
  }

  @Patch(':id/statistics')
  @ApiOperation({
    summary: 'Update Template Statistics',
    description: 'Update statistics for a campaign template (for A/B testing)',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign Template UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Statistics updated successfully',
    type: CampaignTemplate,
  })
  async updateStatistics(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('statistics') statistics: any,
  ): Promise<CampaignTemplate> {
    return await this.campaignTemplatesService.updateStatistics(
      id,
      campaignId,
      statistics,
    );
  }

  @Post(':id/set-winner')
  @ApiOperation({
    summary: 'Set Template as Winner',
    description: 'Mark a template as the winner in A/B testing',
  })
  @ApiParam({
    name: 'campaignId',
    description: 'Campaign UUID',
    type: String,
  })
  @ApiParam({
    name: 'id',
    description: 'Campaign Template UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Template marked as winner successfully',
    type: CampaignTemplate,
  })
  async setWinner(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignTemplate> {
    return await this.campaignTemplatesService.setWinner(id, campaignId);
  }
}
