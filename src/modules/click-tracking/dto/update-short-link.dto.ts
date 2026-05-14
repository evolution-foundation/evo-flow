import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateShortLinkDto } from './create-short-link.dto';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateShortLinkDto extends PartialType(
  OmitType(CreateShortLinkDto, ['customShortCode'] as const),
) {
  @ApiProperty({
    description: 'Whether the link is active',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
