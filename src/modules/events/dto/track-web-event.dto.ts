import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TrackWebEventDto {
  @ApiProperty({
    description:
      'Unique identifier for the message, used as an idempotency key',
    example: '23d04926-78e5-4ebc-853f-f26c84ff629e',
  })
  @IsString()
  messageId: string;

  @ApiProperty({
    description: 'Contact ID for the web event user',
    example: 'user_456',
  })
  @IsString()
  contactId: string;

  @ApiProperty({
    description: 'Type of web event',
    enum: [
      'page_view',
      'form_submit',
      'button_click',
      'chat_message',
      'file_download',
    ],
    example: 'page_view',
  })
  @IsEnum([
    'page_view',
    'form_submit',
    'button_click',
    'chat_message',
    'file_download',
  ])
  eventType:
    | 'page_view'
    | 'form_submit'
    | 'button_click'
    | 'chat_message'
    | 'file_download';

  @ApiProperty({
    description: 'Additional properties for the web event',
    example: {
      url: 'https://example.com/page',
      referrer: 'https://google.com',
      user_agent: 'Mozilla/5.0...',
      ip_address: '192.168.1.1',
    },
  })
  @IsObject()
  properties: Record<string, any>;

  @ApiPropertyOptional({
    description: 'ISO timestamp when the event occurred',
    example: '2024-01-15T10:30:00.000Z',
  })
  @IsOptional()
  @IsString()
  timestamp?: string;

  @ApiPropertyOptional({
    description: 'Anonymous ID for unknown contacts',
    example: 'anon_789',
  })
  @IsOptional()
  @IsString()
  anonymousId?: string;
}
