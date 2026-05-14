import { IsOptional, IsObject, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';

export class IdentifyEventDto extends BaseEventDto {
  @ApiPropertyOptional({
    description: 'Specific event name for identification',
    example: 'contact_updated',
  })
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional({
    description: 'Event properties with change details',
    example: {
      changedFields: ['email', 'name'],
      changeCount: 2,
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Free-form dictionary of traits of the user',
    example: {
      email: 'john@example.com',
      name: 'John Doe',
      age: 30,
      plan: 'premium',
      company: 'Acme Corp',
    },
  })
  @IsOptional()
  @IsObject()
  traits?: Record<string, any>;
}
