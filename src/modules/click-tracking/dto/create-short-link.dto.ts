import {
  IsUrl,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsString,
  IsDateString,
  IsObject,
  ValidateNested,
  IsArray,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { LinkParameterDto } from './link-parameter.dto';

export class CreateShortLinkDto {
  @ApiProperty({
    description: 'Original URL to shorten',
    example: 'https://evolutionapi.com/produto',
  })
  @IsUrl()
  @IsNotEmpty()
  originalUrl: string;

  @ApiProperty({
    description: 'Campaign ID (optional)',
    example: 'uuid-campaign',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  campaignId?: string;

  @ApiProperty({
    description: 'Journey ID (optional)',
    example: 'uuid-journey',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  journeyId?: string;

  @ApiProperty({
    description: 'Contact ID for personalized link (optional)',
    example: 'uuid-contact',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  contactId?: string;

  @ApiProperty({
    description: 'Link title',
    example: 'Promoção Black Friday',
    required: false,
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({
    description: 'Link description',
    example: 'Link para promoção especial de Black Friday',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Is link active',
    example: true,
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    description: 'Expiration date (ISO 8601)',
    example: '2025-11-30T23:59:59Z',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({
    description: 'URL parameters (UTM and custom)',
    type: [LinkParameterDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LinkParameterDto)
  parameters?: LinkParameterDto[];

  @ApiProperty({
    description: 'Custom metadata (JSON)',
    example: { source: 'email', campaign_type: 'promotional' },
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiProperty({
    description: 'Custom short code (optional, if not provided will be auto-generated)',
    example: 'black-friday',
    required: false,
  })
  @IsOptional()
  @IsString()
  customShortCode?: string;

  @ApiProperty({
    description: 'Custom domain ID to use for this link (optional)',
    example: 'uuid-custom-domain',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  customDomainId?: string;

  @ApiProperty({
    description: 'Custom slug for custom domain link (e.g., "comunidade" for evolution-api.com/comunidade)',
    example: 'comunidade',
    required: false,
  })
  @IsOptional()
  @IsString()
  customSlug?: string;
}
