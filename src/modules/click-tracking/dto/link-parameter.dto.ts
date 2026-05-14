import { IsString, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LinkParameterDto {
  @ApiProperty({
    description: 'Parameter key (e.g., utm_source, promo_code)',
    example: 'utm_source',
  })
  @IsString()
  key: string;

  @ApiProperty({
    description: 'Parameter value',
    example: 'email',
  })
  @IsString()
  value: string;

  @ApiProperty({
    description: 'Whether this is a UTM parameter',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isUtm?: boolean;
}
