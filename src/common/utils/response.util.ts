import { HttpStatus } from '@nestjs/common';
import { StandardSuccessResponseDto, MetaDto } from '../dto/standard-response.dto';
import { PaginationMetaDto } from '../dto/pagination-meta.dto';

/**
 * Helper functions to create standardized responses
 * Use these in controllers when you need explicit control over response format
 */

/**
 * Create a standard success response
 */
export function successResponse<T>(
  data: T,
  message?: string,
  requestId?: string,
): StandardSuccessResponseDto<T> {
  const meta: MetaDto = {
    timestamp: new Date().toISOString(),
    ...(requestId && { requestId }),
  };

  return {
    success: true,
    data,
    meta,
    ...(message && { message }),
  };
}

/**
 * Create a standard paginated response
 */
export function paginatedResponse<T>(
  data: T[],
  page: number,
  pageSize: number,
  total: number,
  message?: string,
  requestId?: string,
): StandardSuccessResponseDto<T[]> {
  const totalPages = Math.ceil(total / pageSize) || 1;

  const pagination: PaginationMetaDto = {
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_next_page: page < totalPages,
    has_previous_page: page > 1,
  };

  const meta: MetaDto = {
    timestamp: new Date().toISOString(),
    pagination,
    ...(requestId && { requestId }),
  };

  return {
    success: true,
    data,
    meta,
    ...(message && { message }),
  };
}

/**
 * Calculate pagination metadata from query parameters
 */
export function calculatePagination(
  page: number = 1,
  pageSize: number = 20,
  total: number,
): PaginationMetaDto {
  const totalPages = Math.ceil(total / pageSize) || 1;

  return {
    page: Math.max(1, page),
    page_size: Math.max(1, Math.min(100, pageSize)),
    total,
    total_pages: totalPages,
    has_next_page: page < totalPages,
    has_previous_page: page > 1,
  };
}

/**
 * Normalize pagination parameters from query
 */
export function normalizePaginationParams(
  page?: number,
  pageSize?: number,
  limit?: number,
): { page: number; pageSize: number } {
  const normalizedPage = Math.max(1, page || 1);
  const normalizedPageSize = Math.max(
    1,
    Math.min(100, pageSize || limit || 20),
  );

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

