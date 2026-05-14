import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';

export class ScreenEventDto extends BaseEventDto {
  @ApiPropertyOptional({
    description: 'Name of the screen visited by the user',
    example: 'Dashboard',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Free-form dictionary of properties of the screen',
    example: {
      title: 'User Dashboard',
      section: 'main',
      version: '1.2.3',
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;
}
