import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsNumber,
  IsString,
  IsEnum,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { CampaignStatus, CampaignType, CampaignChannelType } from '../entities/campaign.entity';

export enum CampaignSortField {
  NAME = 'name',
  CREATED_AT = 'created_at',
  STATUS = 'status',
  SCHEDULE_TO = 'schedule_to',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class CampaignQueryDto {
  @ApiPropertyOptional({
    description: 'Page number for pagination',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 25,
    minimum: 1,
    maximum: 100,
    default: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  per_page?: number = 25;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: CampaignSortField,
    example: CampaignSortField.CREATED_AT,
    default: CampaignSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(CampaignSortField)
  sort?: CampaignSortField = CampaignSortField.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: SortOrder,
    example: SortOrder.DESC,
    default: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder = SortOrder.DESC;

  @ApiPropertyOptional({
    description: 'Filter by campaign status (multiple values supported)',
    enum: CampaignStatus,
    isArray: true,
    example: [CampaignStatus.DRAFT, CampaignStatus.SENDING],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(v => parseInt(v));
    if (typeof value === 'string') return [parseInt(value)];
    return [value];
  })
  status?: CampaignStatus[];

  @ApiPropertyOptional({
    description: 'Filter by campaign type (multiple values supported)',
    enum: CampaignType,
    isArray: true,
    example: [CampaignType.SIMPLE],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    return [value];
  })
  type?: CampaignType[];

  @ApiPropertyOptional({
    description: 'Filter by channel type (multiple values supported)',
    enum: CampaignChannelType,
    isArray: true,
    example: [CampaignChannelType.WHATSAPP],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    return [value];
  })
  channel_type?: CampaignChannelType[];

  @ApiPropertyOptional({
    description: 'Search query to filter campaigns by title or name',
    example: 'Black Friday',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
