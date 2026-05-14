import {
  Controller,
  Get,
  Delete,
  Post,
  Param,
  Query,
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
  ApiQuery,
} from '@nestjs/swagger';
import { JourneySessionsService } from './services/journey-sessions.service';
import { JourneySessionStatus } from './entities/journey-session.entity';

@ApiTags('Journey Sessions')
@Controller('journeys/:journeyId/sessions')
export class JourneySessionsController {
  constructor(
    private readonly sessionsService: JourneySessionsService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all sessions for a journey' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: JourneySessionStatus,
    description: 'Filter by session status',
  })
  @ApiQuery({
    name: 'contactId',
    required: false,
    type: 'string',
    description: 'Filter by contact ID',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: 'number',
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: 'number',
    description: 'Page size (default: 50)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of journey sessions',
  })
  async findAll(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Query('status') status?: JourneySessionStatus,
    @Query('contactId') contactId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const filters = {
      status,
      contactId,
    };

    const pageNumber = page ? parseInt(page, 10) : 1;
    const pageSizeNumber = pageSize ? parseInt(pageSize, 10) : 50;

    return await this.sessionsService.findByJourneyId(
      journeyId,
      filters,
      pageNumber,
      pageSizeNumber,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get session statistics for a journey' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Session statistics',
  })
  async getStats(@Param('journeyId', ParseUUIDPipe) journeyId: string) {
    return await this.sessionsService.getStats(journeyId);
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'Get a specific session by ID' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    format: 'uuid',
    description: 'Session ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Session details',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session not found',
  })
  async findOne(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return await this.sessionsService.findOne(sessionId, journeyId);
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a session' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    format: 'uuid',
    description: 'Session ID',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Session deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session not found',
  })
  async remove(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    await this.sessionsService.remove(sessionId, journeyId);
  }

  @Post(':sessionId/cancel')
  @ApiOperation({ summary: 'Cancel an active session' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    format: 'uuid',
    description: 'Session ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Session cancelled successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session not found',
  })
  async cancel(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return await this.sessionsService.cancel(sessionId, journeyId);
  }

  @Delete('bulk/:status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk delete sessions by status' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiParam({
    name: 'status',
    enum: JourneySessionStatus,
    description: 'Status to filter sessions for deletion',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Number of sessions deleted',
    schema: {
      type: 'object',
      properties: {
        deleted: { type: 'number' },
      },
    },
  })
  async bulkDelete(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Param('status') status: JourneySessionStatus,
  ) {
    const deleted = await this.sessionsService.bulkDeleteByStatus(
      journeyId,
      status,
    );
    return { deleted };
  }
}
