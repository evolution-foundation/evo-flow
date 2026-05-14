import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';

export class PageEventDto extends BaseEventDto {
  @ApiPropertyOptional({
    description: 'Name of the page visited by the user',
    example: 'Home',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Free-form dictionary of properties of the page',
    example: {
      title: 'Welcome to Our App',
      url: 'https://app.example.com/home',
      referrer: 'https://google.com',
      path: '/home',
    },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, any>;
}
