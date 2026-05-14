import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { CreateShortLinkDto } from './create-short-link.dto';

export class BulkCreateLinksDto {
  @ApiProperty({
    description: 'Array of links to create',
    type: [CreateShortLinkDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShortLinkDto)
  links: CreateShortLinkDto[];
}
