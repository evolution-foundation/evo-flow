import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {
  SegmentsService,
  SEGMENT_PREVIEW_SAMPLE_SIZE,
} from './segments.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { PreviewSegmentDto } from './dto/preview-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { FilterSegmentsDto } from './dto/filter-segments.dto';
import { SegmentResponseDto } from './dto/segment-response.dto';
import { SegmentApiGuard } from './guards/segment-api.guard';
import { SegmentModeManagerService } from './services/segment-mode-manager.service';

@ApiTags('Segments')
@Controller('segments')
@UseGuards(SegmentApiGuard)
export class SegmentsController {
  constructor(
    private readonly segmentsService: SegmentsService,
    private readonly cls: ClsService,
    private readonly segmentModeManager: SegmentModeManagerService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new segment' })
  @ApiResponse({
    status: 201,
    description: 'The segment has been successfully created.',
    type: SegmentResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request.' })
  async create(
    @Body() createSegmentDto: CreateSegmentDto,
  ): Promise<SegmentResponseDto> {
    return this.segmentsService.create(createSegmentDto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a segment definition without persisting it',
    description:
      'Computes an inline segment definition and returns the in-segment ' +
      `contact count plus a sample of up to ${SEGMENT_PREVIEW_SAMPLE_SIZE} ids. ` +
      'Nothing is persisted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Preview computed successfully.',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 142 },
        sample: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    },
  })
  @ApiResponse({ status: 422, description: 'Invalid segment definition.' })
  async preview(
    @Body() previewSegmentDto: PreviewSegmentDto,
  ): Promise<{ count: number; sample: { id: string }[] }> {
    return this.segmentsService.previewByDefinition(
      previewSegmentDto.definition,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all segments with filtering' })
  @ApiResponse({
    status: 200,
    description: 'List of segments retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: { $ref: '#/components/schemas/SegmentResponseDto' },
        },
        total: { type: 'number', example: 100 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 10 },
      },
    },
  })
  async findAll(@Query() filter: FilterSegmentsDto): Promise<{
    segments: SegmentResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.segmentsService.findAll(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a segment by ID' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'The segment has been successfully retrieved.',
    type: SegmentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async findOne(@Param('id') id: string): Promise<SegmentResponseDto> {
    return this.segmentsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a segment (PATCH)' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'The segment has been successfully updated.',
    type: SegmentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async update(
    @Param('id') id: string,
    @Body() updateSegmentDto: UpdateSegmentDto,
  ): Promise<SegmentResponseDto> {
    return this.segmentsService.update(id, updateSegmentDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a segment (PUT)' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'The segment has been successfully updated.',
    type: SegmentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async updatePut(
    @Param('id') id: string,
    @Body() updateSegmentDto: UpdateSegmentDto,
  ): Promise<SegmentResponseDto> {
    return this.segmentsService.update(id, updateSegmentDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a segment' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'The segment has been successfully deleted.',
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async remove(@Param('id') id: string): Promise<{ message: string }> {
    await this.segmentsService.remove(id);
    return { message: 'Segment deleted successfully' };
  }

  @Post(':id/recompute')
  @ApiOperation({ summary: 'Recompute a segment' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'The segment has been successfully recomputed.',
    type: SegmentResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async recompute(@Param('id') id: string): Promise<SegmentResponseDto> {
    return this.segmentsService.recomputeSegment(id);
  }

  @Post('recompute-all')
  @ApiOperation({ summary: 'Recompute all segments for the account' })
  @ApiResponse({
    status: 200,
    description: 'All segments have been successfully recomputed.',
    schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              segmentId: { type: 'string' },
              contactsAdded: { type: 'number' },
              contactsRemoved: { type: 'number' },
              totalContacts: { type: 'number' },
              processingTimeMs: { type: 'number' },
            },
          },
        },
        totalProcessingTimeMs: { type: 'number' },
      },
    },
  })
  async recomputeAll(): Promise<{
    results: any[];
    totalProcessingTimeMs: number;
  }> {
    const startTime = Date.now();
    const results = await this.segmentsService.recomputeAllSegments();

    return {
      results,
      totalProcessingTimeMs: Date.now() - startTime,
    };
  }

  @Get(':id/contacts')
  @ApiOperation({ summary: 'Get contacts in a segment' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiQuery({
    name: 'page',
    type: 'number',
    required: false,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Items per page',
  })
  @ApiResponse({
    status: 200,
    description: 'Contacts in the segment retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          items: { $ref: '#/components/schemas/Contact' },
        },
        total: { type: 'number', example: 50 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 10 },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async getSegmentContacts(
    @Param('id') id: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ): Promise<{
    contactIds: string[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.segmentsService.getSegmentContacts(id, +page, +limit);
  }

  @Get(':id/contact-ids')
  @ApiOperation({ summary: 'Get contact IDs in a segment' })
  @ApiParam({ name: 'id', type: 'string', description: 'Segment ID (UUID)' })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Maximum number of contact IDs to return',
  })
  @ApiQuery({
    name: 'offset',
    type: 'number',
    required: false,
    description: 'Offset for pagination',
  })
  @ApiResponse({
    status: 200,
    description: 'Contact IDs in the segment retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        contactIds: {
          type: 'array',
          items: { type: 'string' },
        },
        total: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Segment not found.' })
  async getSegmentContactIds(
    @Param('id') id: string,
    @Query('limit') limit: number = 1000,
    @Query('offset') offset: number = 0,
  ): Promise<{
    contactIds: string[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return this.segmentsService.getSegmentContactIds(id, +limit, +offset);
  }
}
