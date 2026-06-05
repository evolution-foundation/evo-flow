import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { JourneysService } from './journeys.service';
import { CreateJourneyDto, UpdateJourneyDto, JourneyResponseDto } from './dto';

@ApiTags('Journeys')
@Controller('journeys')
export class JourneysController {
  constructor(
    private readonly journeysService: JourneysService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new journey' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Journey created successfully',
    type: JourneyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  async create(
    @Body() createJourneyDto: CreateJourneyDto,
  ): Promise<JourneyResponseDto> {
    return await this.journeysService.create(createJourneyDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all journeys for the account' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of journeys',
    type: [JourneyResponseDto],
  })
  async findAll(): Promise<JourneyResponseDto[]> {
    return await this.journeysService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a journey by ID' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey found',
    type: JourneyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JourneyResponseDto> {
    return await this.journeysService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a journey' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey updated successfully',
    type: JourneyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateJourneyDto: UpdateJourneyDto,
  ): Promise<JourneyResponseDto> {
    return await this.journeysService.update(id, updateJourneyDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a journey' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Journey deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.journeysService.remove(id);
  }

  @Post(':id/toggle-active')
  @ApiOperation({ summary: 'Toggle journey active status' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey status toggled successfully',
    type: JourneyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async toggleActive(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JourneyResponseDto> {
    return await this.journeysService.toggleActive(id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a journey' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID to duplicate',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Journey duplicated successfully',
    type: JourneyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JourneyResponseDto> {
    return await this.journeysService.duplicate(id);
  }

  @Get(':id/variables')
  @ApiOperation({ summary: 'Get journey variables' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey variables retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['text', 'number', 'boolean', 'date'] },
          defaultValue: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async getJourneyVariables(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<any[]> {
    return await this.journeysService.getJourneyVariables(id);
  }

  @Post(':id/variables')
  @ApiOperation({ summary: 'Update journey variables' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiBody({
    description: 'Journey variables to update',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['text', 'number', 'boolean', 'date'] },
          defaultValue: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['id', 'name', 'type'],
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey variables updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Journey not found',
  })
  async updateJourneyVariables(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() variables: any[],
  ): Promise<any[]> {
    return await this.journeysService.updateJourneyVariables(id, variables);
  }

  @Get('trigger-type/:triggerType')
  @ApiOperation({ summary: 'Get journeys by trigger type' })
  @ApiParam({
    name: 'triggerType',
    type: 'string',
    description: 'Type of trigger',
    enum: [
      'Event',
      'Segment',
      'Manual',
      'Schedule',
      'Webhook',
      'ContactField',
      'ContactCreated',
      'ContactUpdated',
      'Label',
      'CustomAttribute',
    ],
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of journeys with the specified trigger type',
    type: [JourneyResponseDto],
  })
  async findByTriggerType(
    @Param('triggerType') triggerType: string,
  ): Promise<JourneyResponseDto[]> {
    return await this.journeysService.findByTriggerType(triggerType);
  }

  @Post('trigger/:journeyId')
  @ApiOperation({ summary: 'Trigger specific journey via webhook' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID to trigger',
  })
  @ApiBody({
    description: 'Webhook payload to trigger journey',
    schema: {
      type: 'object',
      properties: {
        contact_id: {
          type: 'string',
          description: 'Contact ID to trigger journey for',
        },
        timestamp: {
          type: 'string',
          format: 'date-time',
          description: 'Event timestamp (optional, defaults to current time)',
        },
        data: {
          type: 'object',
          description:
            'Additional data for the trigger (accepts any structure)',
          additionalProperties: true,
        },
      },
      required: ['contact_id'],
      additionalProperties: true,
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Journey webhook trigger processed successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        messageId: { type: 'string' },
        journeyId: { type: 'string' },
        contactId: { type: 'string' },
        processedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async triggerSpecificJourneyWebhook(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Body() payload: any,
  ): Promise<{
    success: boolean;
    messageId: string;
    journeyId: string;
    contactId: string;
    processedAt: Date;
  }> {
    return await this.journeysService.processSpecificJourneyWebhookTrigger(
      journeyId,
      payload,
    );
  }
}
