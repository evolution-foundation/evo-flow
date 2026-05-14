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
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { ClickTrackingService } from '../services';
import {
  CreateShortLinkDto,
  UpdateShortLinkDto,
  BulkCreateLinksDto,
} from '../dto';

/**
 * Click Tracking Controller
 * Authenticated API for managing short links
 */
@ApiTags('Click Tracking')
@Controller('click-tracking')
export class ClickTrackingController {
  constructor(
    private readonly clickTrackingService: ClickTrackingService,
    private readonly cls: ClsService,
  ) {}

  @Post('links')
  @ApiOperation({
    summary: 'Create Short Link',
    description:
      'Create a new short link with optional parameters and campaign context',
  })
  @ApiBody({ type: CreateShortLinkDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Short link created successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Custom short code already in use',
  })
  async createLink(@Body() dto: CreateShortLinkDto) {
    return await this.clickTrackingService.create(dto);
  }

  @Post('links/bulk')
  @ApiOperation({
    summary: 'Bulk Create Short Links',
    description: 'Create multiple short links in a single request',
  })
  @ApiBody({ type: BulkCreateLinksDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Short links created successfully',
  })
  async bulkCreateLinks(@Body() dto: BulkCreateLinksDto) {
    return await this.clickTrackingService.bulkCreate(dto);
  }

  @Get('links')
  @ApiOperation({
    summary: 'List Short Links',
    description: 'Get all short links for the account with optional filtering',
  })
  @ApiQuery({
    name: 'campaignId',
    required: false,
    description: 'Filter by campaign ID',
  })
  @ApiQuery({
    name: 'journeyId',
    required: false,
    description: 'Filter by journey ID',
  })
  @ApiQuery({
    name: 'isActive',
    required: false,
    description: 'Filter by active status',
    type: 'boolean',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of results to return',
    type: 'number',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of results to skip',
    type: 'number',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Short links retrieved successfully',
  })
  async listLinks(
    @Query('campaignId') campaignId?: string,
    @Query('journeyId') journeyId?: string,
    @Query('isActive') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return await this.clickTrackingService.findAll({
      campaignId,
      journeyId,
      isActive,
      limit,
      offset,
    });
  }

  @Get('links/:id')
  @ApiOperation({
    summary: 'Get Short Link',
    description: 'Get a specific short link by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Short link ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Short link retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Short link not found',
  })
  async getLink(@Param('id') id: string) {
    return await this.clickTrackingService.findById(id);
  }

  @Get('links/code/:shortCode')
  @ApiOperation({
    summary: 'Get Short Link by Code',
    description: 'Get a specific short link by its short code',
  })
  @ApiParam({
    name: 'shortCode',
    description: 'Short code identifier',
    example: 'abc123',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Short link retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Short link not found',
  })
  async getLinkByCode(@Param('shortCode') shortCode: string) {
    return await this.clickTrackingService.findByShortCode(shortCode);
  }

  @Patch('links/:id')
  @ApiOperation({
    summary: 'Update Short Link',
    description: 'Update a short link configuration',
  })
  @ApiParam({
    name: 'id',
    description: 'Short link ID (UUID)',
  })
  @ApiBody({ type: UpdateShortLinkDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Short link updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Short link not found',
  })
  async updateLink(@Param('id') id: string, @Body() dto: UpdateShortLinkDto) {
    return await this.clickTrackingService.update(id, dto);
  }

  @Delete('links/:id')
  @ApiOperation({
    summary: 'Delete Short Link',
    description: 'Delete a short link',
  })
  @ApiParam({
    name: 'id',
    description: 'Short link ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Short link deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Short link not found',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLink(@Param('id') id: string) {
    await this.clickTrackingService.delete(id);
  }

  @Post('links/sync-clicks')
  @ApiOperation({
    summary: 'Sync Click Counts',
    description:
      'Sync click counts from Redis to database (periodic maintenance)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Click counts synced successfully',
    schema: {
      type: 'object',
      properties: {
        synced: { type: 'number', example: 42 },
        message: { type: 'string', example: 'Synced 42 link click counts' },
      },
    },
  })
  async syncClickCounts() {
    const synced = await this.clickTrackingService.syncClickCounts();
    return {
      synced,
      message: `Synced ${synced} link click counts`,
    };
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get Link Statistics',
    description: 'Get aggregated statistics for all short links in the account',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Statistics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        totalLinks: { type: 'number', example: 150 },
        activeLinks: { type: 'number', example: 142 },
        totalClicks: { type: 'number', example: 5234 },
        topLinks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              shortCode: { type: 'string', example: 'abc123' },
              clickCount: { type: 'number', example: 523 },
            },
          },
        },
      },
    },
  })
  async getStats() {
    return await this.clickTrackingService.getStats();
  }
}
