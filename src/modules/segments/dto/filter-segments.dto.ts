import { IsOptional, IsString, IsNumber, IsIn, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class FilterSegmentsDto {
  @ApiProperty({
    description: 'Filter segments by specific IDs (UUIDs)',
    type: [String],
    required: false,
    example: [
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((id) => id.trim());
    }
    return value;
  })
  ids?: string[];

  @ApiProperty({
    description: 'Filter by segment status',
    enum: ['running', 'paused', 'completed'],
    required: false,
    example: 'running',
  })
  @IsOptional()
  @IsIn(['running', 'paused', 'completed'])
  status?: string;

  @ApiProperty({
    description: 'Search segments by name',
    required: false,
    example: 'active',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    description: 'Page number for pagination',
    example: 1,
    default: 1,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @ApiProperty({
    description: 'Number of items per page',
    example: 10,
    default: 10,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 10;
}
