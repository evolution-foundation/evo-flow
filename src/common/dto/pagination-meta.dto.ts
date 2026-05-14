import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/**
 * Pagination metadata matching API_RESPONSE_STANDARD.md
 * Uses snake_case for API responses to match frontend expectations
 */
export class PaginationMetaDto {
  @ApiProperty({
    description: 'Current page number (1-indexed)',
    example: 2,
    name: 'page',
  })
  @Expose({ name: 'page' })
  page: number;

  @ApiProperty({
    description: 'Number of items per page',
    example: 20,
    name: 'page_size',
  })
  @Expose({ name: 'page_size' })
  page_size: number;

  @ApiProperty({
    description: 'Total number of items',
    example: 156,
    name: 'total',
  })
  @Expose({ name: 'total' })
  total: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 8,
    name: 'total_pages',
  })
  @Expose({ name: 'total_pages' })
  total_pages: number;

  @ApiProperty({
    description: 'Whether there is a next page',
    example: true,
    name: 'has_next_page',
  })
  @Expose({ name: 'has_next_page' })
  has_next_page: boolean;

  @ApiProperty({
    description: 'Whether there is a previous page',
    example: true,
    name: 'has_previous_page',
  })
  @Expose({ name: 'has_previous_page' })
  has_previous_page: boolean;
}
