import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TrackWhatsAppEventDto {
  @ApiProperty({
    description:
      'Unique identifier for the message, used as an idempotency key',
    example: '23d04926-78e5-4ebc-853f-f26c84ff629e',
  })
  @IsString()
  messageId: string;

  @ApiProperty({
    description: 'Contact ID for the WhatsApp message recipient',
    example: 'user_456',
  })
  @IsString()
  contactId: string;

  @ApiProperty({
    description: 'Type of WhatsApp event',
    enum: ['sent', 'delivered', 'read', 'replied', 'failed'],
    example: 'delivered',
  })
  @IsEnum(['sent', 'delivered', 'read', 'replied', 'failed'])
  eventType: 'sent' | 'delivered' | 'read' | 'replied' | 'failed';

  @ApiProperty({
    description: 'Additional properties for the WhatsApp event',
    example: {
      phone_number: '+5511999999999',
      message_type: 'text',
      conversation_id: 'conv_123',
      reply_content: 'Thank you for the message',
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
