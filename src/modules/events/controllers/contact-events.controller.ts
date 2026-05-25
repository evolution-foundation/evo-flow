import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { ContactEventsResponseDto } from '../dto/contact-event-response.dto';
import { ListContactEventsQueryDto } from '../dto/list-contact-events-query.dto';
import { ContactEventsService } from '../services/contact-events.service';

@ApiTags('Contact Events')
@Controller('contacts')
export class ContactEventsController {
  private readonly logger = new CustomLoggerService(
    ContactEventsController.name,
  );

  constructor(private readonly contactEventsService: ContactEventsService) {}

  @Get(':id/events')
  @ApiOperation({
    summary: 'List Contact Events (Cursor)',
    description:
      'Returns the event timeline for a contact, paginated with an opaque base64 cursor. Ordered by occurred_at DESC, id DESC.',
  })
  @ApiParam({
    name: 'id',
    description: 'Contact ID (UUID)',
    example: 'a3f1b2c4-5d6e-7f80-91a2-b3c4d5e6f708',
  })
  @ApiQuery({
    name: 'eventType',
    required: false,
    description: 'Filter by event types (CSV)',
    example: 'track,identify',
  })
  @ApiQuery({
    name: 'eventName',
    required: false,
    description: 'Filter by event names (CSV)',
    example: 'message.delivered,message.read',
  })
  @ApiQuery({
    name: 'channel',
    required: false,
    description: 'Filter by properties.channel',
    example: 'whatsapp',
  })
  @ApiQuery({
    name: 'campaignId',
    required: false,
    description: 'Filter by properties.campaign_id',
    example: 'cmp_42',
  })
  @ApiQuery({
    name: 'occurredAfter',
    required: false,
    description: 'Lower bound for occurred_at (ISO8601, inclusive)',
    example: '2026-04-01T00:00:00Z',
  })
  @ApiQuery({
    name: 'occurredBefore',
    required: false,
    description: 'Upper bound for occurred_at (ISO8601, inclusive)',
    example: '2026-04-30T23:59:59Z',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque base64 cursor from previous response',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (default 50, max 100)',
    example: 50,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Events retrieved successfully',
    type: ContactEventsResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid query parameters or cursor',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid authentication',
  })
  async list(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListContactEventsQueryDto,
  ): Promise<ContactEventsResponseDto> {
    return this.contactEventsService.list(id, query);
  }
}
