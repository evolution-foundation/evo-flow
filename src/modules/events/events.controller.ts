import {
  Controller,
  Post,
  Body,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventsService } from './events.service';
import {
  TrackEventDto,
  IdentifyEventDto,
  PageEventDto,
  ScreenEventDto,
  TrackEmailEventDto,
  TrackWhatsAppEventDto,
  TrackSmsEventDto,
  TrackWebEventDto,
  TrackBatchEventsDto,
  BatchProcessingResultDto,
} from './dto';
import { EventSchemaValidationPipe } from './pipes/event-schema-validation.pipe';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@ApiTags('Events')
@Controller('events')
export class EventsController {
  private readonly logger = new CustomLoggerService(EventsController.name);

  constructor(private readonly eventsService: EventsService) {}

  @Post('track')
  @ApiOperation({
    summary: 'Track Event',
    description: 'Record a track event when a user performs an action',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid event data',
  })
  async trackEvent(
    @Body(EventSchemaValidationPipe) trackEventDto: TrackEventDto,
  ) {
    this.logger.log(`Received track event: ${trackEventDto.event}`);
    return await this.eventsService.trackEvent(trackEventDto);
  }

  @Post('identify')
  @ApiOperation({
    summary: 'Identify Event',
    description: 'Record an identify event to associate traits with a user',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid event data',
  })
  async identifyEvent(
    @Body(EventSchemaValidationPipe) identifyEventDto: IdentifyEventDto,
  ) {
    this.logger.log('Received identify event');
    return await this.eventsService.identifyEvent(identifyEventDto);
  }

  @Post('page')
  @ApiOperation({
    summary: 'Page Event',
    description: 'Record a page view event',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid event data',
  })
  async pageEvent(@Body() pageEventDto: PageEventDto) {
    this.logger.log(`Received page event: ${pageEventDto.name}`);
    return await this.eventsService.pageEvent(pageEventDto);
  }

  @Post('screen')
  @ApiOperation({
    summary: 'Screen Event',
    description: 'Record a screen view event (for mobile apps)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid event data',
  })
  async screenEvent(@Body() screenEventDto: ScreenEventDto) {
    this.logger.log(`Received screen event: ${screenEventDto.name}`);
    return await this.eventsService.screenEvent(screenEventDto);
  }

  // ==================== CONVENIENCE ENDPOINTS ====================

  @Post('email')
  @UsePipes(new ValidationPipe())
  @ApiOperation({
    summary: 'Track Email Event',
    description:
      'Convenient endpoint for email events (sent, opened, clicked, etc.)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Email event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid email event data',
  })
  async trackEmailEvent(@Body() body: TrackEmailEventDto) {
    this.logger.log(
      `Received email event: ${body.eventType} for contact: ${body.contactId}`,
    );
    return await this.eventsService.trackEmailEvent(body);
  }

  @Post('whatsapp')
  @UsePipes(new ValidationPipe())
  @ApiOperation({
    summary: 'Track WhatsApp Event',
    description:
      'Convenient endpoint for WhatsApp events (sent, delivered, read, replied)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'WhatsApp event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid WhatsApp event data',
  })
  async trackWhatsAppEvent(@Body() body: TrackWhatsAppEventDto) {
    this.logger.log(
      `Received WhatsApp event: ${body.eventType} for contact: ${body.contactId}`,
    );
    return await this.eventsService.trackWhatsAppEvent(body);
  }

  @Post('sms')
  @UsePipes(new ValidationPipe())
  @ApiOperation({
    summary: 'Track SMS Event',
    description:
      'Convenient endpoint for SMS events (sent, delivered, failed, replied)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'SMS event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid SMS event data',
  })
  async trackSmsEvent(@Body() body: TrackSmsEventDto) {
    this.logger.log(
      `Received SMS event: ${body.eventType} for contact: ${body.contactId}`,
    );
    return await this.eventsService.trackSmsEvent(body);
  }

  @Post('web')
  @UsePipes(new ValidationPipe())
  @ApiOperation({
    summary: 'Track Web Event',
    description:
      'Convenient endpoint for web events (page views, form submissions, etc.)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Web event recorded successfully',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid web event data',
  })
  async trackWebEvent(@Body() body: TrackWebEventDto) {
    this.logger.log(
      `Received web event: ${body.eventType} for contact: ${body.contactId}`,
    );
    return await this.eventsService.trackWebEvent(body);
  }

  @Post('batch')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: false }))
  @ApiOperation({
    summary: 'Track Batch Events',
    description: 'Record a batch of events',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Batch events processed successfully',
    type: BatchProcessingResultDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid batch event data',
  })
  async trackBatchEvents(@Body() body: TrackBatchEventsDto) {
    this.logger.log(`Received batch of ${body.events.length} events`);
    // Log primeiro evento para debug
    if (body.events && body.events.length > 0) {
      this.logger.debug(`First event sample: ${JSON.stringify(body.events[0])}`);
    }
    return await this.eventsService.trackBatchEvents(body.events);
  }
}
