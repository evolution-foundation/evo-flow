import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';

export class TrackEventDto extends BaseEventDto {
  @ApiProperty({
    description: 'Name of the action that a user has performed',
    example: 'COURSE_CLICKED',
  })
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
