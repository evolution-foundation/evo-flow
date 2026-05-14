import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsArray,
  IsEnum,
  IsDateString,
  IsNumber,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { EventType } from '../../../common/enums/event-type.enum';

export class SearchEventsDto {
  @ApiPropertyOptional({
    description: 'Contact ID to filter events',
    example: 'contact_12345',
  })
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional({
    description: 'Event type filter',
    enum: EventType,
    example: EventType.TRACK,
  })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({
    description: 'Multiple event types filter',
    enum: EventType,
    isArray: true,
    example: [EventType.TRACK, EventType.PAGE],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(EventType, { each: true })
  eventTypes?: EventType[];

  @ApiPropertyOptional({
    description: 'Single event name filter',
    example: 'purchase_completed',
  })
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional({
    description: 'Multiple event names filter',
    example: ['purchase_completed', 'cart_abandoned', 'signup'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eventNames?: string[];

  @ApiPropertyOptional({
    description: 'Start date for filtering events (ISO string)',
    example: '2024-01-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for filtering events (ISO string)',
    example: '2024-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 1)
  @IsNumber()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page (max 100)',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Transform(({ value }) => Math.min(parseInt(value) || 20, 100))
  @IsNumber()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Data source preference',
    enum: ['auto', 'postgres', 'clickhouse'],
    default: 'auto',
  })
  @IsOptional()
  @IsEnum(['auto', 'postgres', 'clickhouse'])
  source?: 'auto' | 'postgres' | 'clickhouse' = 'auto';

  @ApiPropertyOptional({
    description: 'Sort order for events',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class EventSearchResultDto {
  @ApiProperty({ description: 'Event ID' })
  id: string;

  @ApiProperty({ description: 'Event type' })
  eventType: string;

  @ApiProperty({ description: 'Event name' })
  eventName: string;

  @ApiProperty({ description: 'Contact ID', required: false })
  contactId?: string;

  @ApiProperty({ description: 'Anonymous ID', required: false })
  anonymousId?: string;

  @ApiProperty({ description: 'Event timestamp' })
  occurredAt: Date;

  @ApiProperty({ description: 'Event properties' })
  properties: Record<string, any>;

  @ApiProperty({ description: 'Event context' })
  context: Record<string, any>;

  @ApiProperty({ description: 'Data source' })
  source: 'postgres' | 'clickhouse';
}

export class EventSearchResponseDto {
  @ApiProperty({
    description: 'List of events',
    type: [EventSearchResultDto],
  })
  events: EventSearchResultDto[];

  @ApiProperty({ description: 'Pagination metadata' })
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };

  @ApiProperty({ description: 'Search metadata' })
  meta: {
    searchTime: number;
    source: string;
    filters: Record<string, any>;
  };
}
