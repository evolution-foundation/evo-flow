import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Subset of EventType that the ClickHouse `contact_events.event_type` Enum8
// actually accepts (clickhouse.service.ts:461). `journey` is intentionally
// excluded — it is part of the application-level enum but not of the column
// definition; allowing it through would crash the query with
// "Unknown element 'journey' for type Enum8(...)".
const CONTACT_EVENT_CH_TYPES = [
  'identify',
  'track',
  'page',
  'screen',
  'segment',
] as const;
export type ContactEventChType = (typeof CONTACT_EVENT_CH_TYPES)[number];

const csvToArray = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
};

export class ListContactEventsQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter by event types (CSV). Subset of EventType supported by the ClickHouse column.',
    enum: CONTACT_EVENT_CH_TYPES,
    isArray: true,
    example: 'track,identify',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(CONTACT_EVENT_CH_TYPES as unknown as string[], { each: true })
  eventType?: ContactEventChType[];

  @ApiPropertyOptional({
    description: 'Filter by event names (CSV)',
    isArray: true,
    example: 'message.delivered,message.read',
  })
  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  eventName?: string[];

  @ApiPropertyOptional({
    description: 'Filter by channel (extracted from properties.channel)',
    example: 'whatsapp',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  channel?: string;

  @ApiPropertyOptional({
    description:
      'Filter by campaign id (extracted from properties.campaign_id)',
    example: 'cmp_42',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  campaignId?: string;

  @ApiPropertyOptional({
    description: 'Lower bound for occurred_at (ISO8601, inclusive)',
    example: '2026-04-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  occurredAfter?: string;

  @ApiPropertyOptional({
    description: 'Upper bound for occurred_at (ISO8601, inclusive)',
    example: '2026-04-30T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  occurredBefore?: string;

  @ApiPropertyOptional({
    description: 'Opaque forward cursor from previous response',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Items per page (default 50, max 100)',
    default: 50,
    example: 50,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : parseInt(value as string, 10),
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}
