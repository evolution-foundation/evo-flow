import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TrackEmailEventDto {
  @ApiProperty({
    description:
      'Unique identifier for the message, used as an idempotency key',
    example: '23d04926-78e5-4ebc-853f-f26c84ff629e',
  })
  @IsString()
  messageId: string;

  @ApiProperty({
    description: 'Contact ID for the email recipient',
    example: 'user_456',
  })
  @IsString()
  contactId: string;

  @ApiProperty({
    description: 'Type of email event',
    enum: [
      'sent',
      'delivered',
      'opened',
      'clicked',
      'bounced',
      'unsubscribed',
      'spam',
    ],
    example: 'opened',
  })
  @IsEnum([
    'sent',
    'delivered',
    'opened',
    'clicked',
    'bounced',
    'unsubscribed',
    'spam',
  ])
  eventType:
    | 'sent'
    | 'delivered'
    | 'opened'
    | 'clicked'
    | 'bounced'
    | 'unsubscribed'
    | 'spam';

  @ApiProperty({
    description: 'Additional properties for the email event',
    example: {
      subject: 'Welcome to our platform',
      campaign_id: 'camp_123',
      template_id: 'tpl_456',
      click_url: 'https://example.com/link',
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
}
