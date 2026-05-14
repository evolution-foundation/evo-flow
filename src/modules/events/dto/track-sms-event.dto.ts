import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TrackSmsEventDto {
  @ApiProperty({
    description:
      'Unique identifier for the message, used as an idempotency key',
    example: '23d04926-78e5-4ebc-853f-f26c84ff629e',
  })
  @IsString()
  messageId: string;

  @ApiProperty({
    description: 'Contact ID for the SMS recipient',
    example: 'user_456',
  })
  @IsString()
  contactId: string;

  @ApiProperty({
    description: 'Type of SMS event',
    enum: ['sent', 'delivered', 'failed', 'replied'],
    example: 'delivered',
  })
  @IsEnum(['sent', 'delivered', 'failed', 'replied'])
  eventType: 'sent' | 'delivered' | 'failed' | 'replied';

  @ApiProperty({
    description: 'Additional properties for the SMS event',
    example: {
      phone_number: '+5511999999999',
      provider: 'twilio',
      cost: 0.02,
      reply_content: 'Thank you for the SMS',
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
