import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { ScheduledJourneyAction } from './entities/scheduled-journey-action.entity';

@ApiTags('Scheduled Actions')
@Controller('journeys')
export class ScheduledActionsController {
  constructor(
    @InjectRepository(ScheduledJourneyAction)
    private readonly scheduledActionRepository: Repository<ScheduledJourneyAction>,
    private readonly cls: ClsService,
  ) {}

  @Get(':journeyId/scheduled-actions')
  @ApiOperation({ summary: 'Get scheduled actions for a journey' })
  @ApiParam({
    name: 'journeyId',
    type: 'string',
    format: 'uuid',
    description: 'Journey ID',
  })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of scheduled actions',
  })
  async findByJourney(
    @Param('journeyId', ParseUUIDPipe) journeyId: string,
    @Query('skip') skip: number = 0,
    @Query('take') take: number = 20,
  ) {
    const [data, total] = await this.scheduledActionRepository.findAndCount({
      where: {
        journeyId,
      },
      order: { scheduledFor: 'ASC' },
      skip,
      take,
    });

    return {
      data,
      pagination: {
        skip,
        take,
        total,
      },
    };
  }

  @Get('sessions/:sessionId/scheduled-actions')
  @ApiOperation({ summary: 'Get scheduled actions for a journey session' })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    format: 'uuid',
    description: 'Journey Session ID',
  })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of scheduled actions',
  })
  async findBySession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query('skip') skip: number = 0,
    @Query('take') take: number = 20,
  ) {
    const [data, total] = await this.scheduledActionRepository.findAndCount({
      where: {
        sessionId,
      },
      order: { scheduledFor: 'ASC' },
      skip,
      take,
    });

    return {
      data,
      pagination: {
        skip,
        take,
        total,
      },
    };
  }

  @Get('scheduled-actions/:id')
  @ApiOperation({ summary: 'Get a scheduled action by ID' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Scheduled Action ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled action found',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Scheduled action not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.scheduledActionRepository.findOneOrFail({
      where: {
        id,
      },
    });
  }

  @Patch('scheduled-actions/:id')
  @ApiOperation({ summary: 'Update a scheduled action' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Scheduled Action ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scheduled action updated',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateData: any,
  ) {
    const scheduledAction = await this.scheduledActionRepository.findOneOrFail({
      where: {
        id,
      },
    });

    // Only allow updating certain fields
    if (updateData.actionConfig !== undefined) {
      scheduledAction.actionConfig = updateData.actionConfig;
    }

    await this.scheduledActionRepository.save(scheduledAction);

    return scheduledAction;
  }

  @Delete('scheduled-actions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a scheduled action' })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Scheduled Action ID',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Scheduled action deleted',
  })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    const scheduledAction = await this.scheduledActionRepository.findOneOrFail({
      where: {
        id,
      },
    });

    scheduledAction.markAsCancelled();
    await this.scheduledActionRepository.save(scheduledAction);
  }
}
