import { IsString, IsOptional, IsObject, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';
import { EVENT_NAMES } from '../event-names.enum';

export class TrackEventDto extends BaseEventDto {
  @ApiProperty({
    description: 'Name of the action that a user has performed',
    example: 'contact.created',
  })
  @IsIn(EVENT_NAMES, { message: 'event must be one of: $constraint1' })
  @IsString()
  event: string;

  @ApiPropertyOptional({
    description: 'Free-form dictionary of properties of the event',
    example: {
      product_id: 'prod_123',
      price: 99.99,
      currency: 'USD',
      category: 'electronics',
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;
}
