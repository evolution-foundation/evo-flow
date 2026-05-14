import {
  Controller,
  Get,
  Query,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EventSearchService } from '../services/event-search.service';
import {
  SearchEventsDto,
  EventSearchResponseDto,
} from '../dto/search-events.dto';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';

@ApiTags('Events Search')
@Controller('events')
export class EventSearchController {
  private readonly logger = new CustomLoggerService(EventSearchController.name);

  constructor(private readonly eventSearchService: EventSearchService) {}

  @Get()
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({
    summary: 'Search Events',
    description:
      'Search events with flexible filters by contact, event names, types, and date ranges',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Events retrieved successfully',
    type: EventSearchResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid search parameters',
  })
  @ApiQuery({
    name: 'contactId',
    required: false,
    description: 'Filter by contact ID',
    example: 'contact_12345',
  })
  @ApiQuery({
    name: 'eventType',
    required: false,
    description: 'Filter by single event type',
    example: 'track',
  })
  @ApiQuery({
    name: 'eventTypes',
    required: false,
    description: 'Filter by multiple event types (comma-separated)',
    example: 'track,page,identify',
  })
  @ApiQuery({
    name: 'eventName',
    required: false,
    description: 'Filter by single event name',
    example: 'purchase_completed',
  })
  @ApiQuery({
    name: 'eventNames',
    required: false,
    description: 'Filter by multiple event names (comma-separated)',
    example: 'purchase_completed,cart_abandoned,signup',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date filter (ISO string)',
    example: '2024-01-01T00:00:00Z',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date filter (ISO string)',
    example: '2024-12-31T23:59:59Z',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (1-based)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (max 100)',
    example: 20,
  })
  @ApiQuery({
    name: 'source',
    required: false,
    description: 'Data source preference',
    enum: ['auto', 'postgres', 'clickhouse'],
    example: 'auto',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    description: 'Sort order for events',
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  async searchEvents(
    @Query() query: SearchEventsDto,
  ): Promise<EventSearchResponseDto> {
    this.logger.log('Searching events with filters', {
      contactId: query.contactId,
      eventType: query.eventType,
      eventTypes: query.eventTypes,
      eventName: query.eventName,
      eventNames: query.eventNames,
      page: query.page,
      limit: query.limit,
    });

    if (typeof query.eventTypes === 'string') {
      query.eventTypes = (query.eventTypes as string)
        .split(',')
        .map((s) => s.trim()) as any;
    }

    if (typeof query.eventNames === 'string') {
      query.eventNames = (query.eventNames as string)
        .split(',')
        .map((s) => s.trim());
    }

    return await this.eventSearchService.searchEvents(query);
  }

  @Get('by-contact')
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({
    summary: 'Search Events by Contact',
    description: 'Search events for a specific contact with optional filters',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Contact events retrieved successfully',
    type: EventSearchResponseDto,
  })
  @ApiQuery({
    name: 'contactId',
    required: true,
    description: 'Contact ID to search events for',
    example: 'contact_12345',
  })
  async searchEventsByContact(
    @Query() query: SearchEventsDto,
  ): Promise<EventSearchResponseDto> {
    if (!query.contactId) {
      throw new Error('contactId is required for this endpoint');
    }

    this.logger.log('Searching events by contact', {
      contactId: query.contactId,
    });

    if (typeof query.eventTypes === 'string') {
      query.eventTypes = (query.eventTypes as string)
        .split(',')
        .map((s) => s.trim()) as any;
    }

    if (typeof query.eventNames === 'string') {
      query.eventNames = (query.eventNames as string)
        .split(',')
        .map((s) => s.trim());
    }

    return await this.eventSearchService.searchEvents(query);
  }
}
