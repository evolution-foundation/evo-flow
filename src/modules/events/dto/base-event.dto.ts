import { IsString, IsOptional, IsObject, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BaseEventDto {
  @ApiProperty({
    description:
      'Unique identifier for the message, used as an idempotency key',
    example: '23d04926-78e5-4ebc-853f-f26c84ff629e',
  })
  @IsString()
  messageId: string;

  @ApiPropertyOptional({
    description: 'Contact ID for known contacts',
    example: 'user_456',
  })
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional({
    description: 'Anonymous ID for unknown contacts',
    example: 'anon_789',
  })
  @IsOptional()
  @IsString()
  anonymousId?: string;

  @ApiPropertyOptional({
    description: 'ISO timestamp when the event occurred',
    example: '2024-01-15T10:30:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  timestamp?: string;

  @ApiPropertyOptional({
    description: 'Context information about the event',
    example: { userAgent: 'Mozilla/5.0...', ip: '192.168.1.1' },
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, any>;
}
