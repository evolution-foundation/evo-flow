import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationMetaDto } from './pagination-meta.dto';

/**
 * Standard response structure matching API_RESPONSE_STANDARD.md
 * All API responses must follow this format
 */

export class MetaDto {
  @ApiProperty({
    description: 'ISO 8601 timestamp',
    example: '2025-01-15T11:23:45Z',
  })
  timestamp: string;

  @ApiPropertyOptional({
    description: 'Pagination metadata (only present in paginated responses)',
    type: PaginationMetaDto,
  })
  pagination?: PaginationMetaDto;

  @ApiPropertyOptional({
    description: 'Request ID for tracking',
    example: 'req-uuid-abc123',
  })
  requestId?: string;
}

export class ErrorInfoDto {
  @ApiProperty({
    description: 'Standardized error code',
    example: 'VALIDATION_ERROR',
  })
  code: string;

  @ApiProperty({
    description: 'Human-readable error message',
    example: 'Validation failed',
  })
  message: string;

  @ApiPropertyOptional({
    description: 'Additional error details',
    example: [
      {
        field: 'email',
        message: 'Invalid email format',
        value: 'invalid-email',
      },
    ],
  })
  details?: any;
}

export class ErrorMetaDto {
  @ApiProperty({
    description: 'ISO 8601 timestamp',
    example: '2025-01-15T11:23:45Z',
  })
  timestamp: string;

  @ApiProperty({
    description: 'Request path',
    example: '/api/v1/journeys/123',
  })
  path: string;

  @ApiProperty({
    description: 'HTTP method',
    example: 'GET',
  })
  method: string;

  @ApiPropertyOptional({
    description: 'Request ID for tracking',
    example: 'req-uuid-abc123',
  })
  requestId?: string;
}

export class StandardSuccessResponseDto<T = any> {
  @ApiProperty({
    description: 'Success indicator',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response data',
  })
  data: T;

  @ApiProperty({
    description: 'Metadata',
    type: MetaDto,
  })
  meta: MetaDto;

  @ApiPropertyOptional({
    description: 'Optional success message',
    example: 'Journey created successfully',
  })
  message?: string;
}

export class StandardErrorResponseDto {
  @ApiProperty({
    description: 'Success indicator',
    example: false,
  })
  success: boolean;

  @ApiProperty({
    description: 'Error information',
    type: ErrorInfoDto,
  })
  error: ErrorInfoDto;

  @ApiProperty({
    description: 'Metadata',
    type: ErrorMetaDto,
  })
  meta: ErrorMetaDto;
}

