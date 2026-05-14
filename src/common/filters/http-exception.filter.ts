import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from '../enums/error-codes.enum';
import {
  StandardErrorResponseDto,
  ErrorInfoDto,
  ErrorMetaDto,
} from '../dto/standard-response.dto';

/**
 * Global exception filter to transform all errors to StandardErrorResponse format
 * Matches API_RESPONSE_STANDARD.md specification
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected error occurred. Please try again later.';
    let details: any = undefined;

    // Handle HttpException (NestJS standard exceptions)
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Extract message and details from exception response
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || message;
        details = responseObj.details || responseObj.errors || undefined;
      }

      // Map status code to error code
      errorCode = this.mapStatusToErrorCode(status, message);
    } else if (exception.status) {
      // Handle exceptions with status property
      status = exception.status;
      message = exception.message || message;
      errorCode = this.mapStatusToErrorCode(status, message);
    } else {
      // Handle unknown errors
      console.error('Unhandled exception:', exception);
      errorCode = ErrorCode.INTERNAL_ERROR;
      message = 'An unexpected error occurred. Please try again later.';
      details = {
        errorId: this.generateErrorId(),
      };
    }

    // Build error info
    const errorInfo: ErrorInfoDto = {
      code: errorCode,
      message,
      ...(details && { details }),
    };

    // Build error metadata
    const errorMeta: ErrorMetaDto = {
      timestamp: new Date().toISOString(),
      path: request.path,
      method: request.method,
    };

    // Add request ID if available
    const requestId = request.headers['x-request-id'] as string;
    if (requestId) {
      errorMeta.requestId = requestId;
    }

    // Build standard error response
    const errorResponse: StandardErrorResponseDto = {
      success: false,
      error: errorInfo,
      meta: errorMeta,
    };

    response.status(status).json(errorResponse);
  }

  /**
   * Map HTTP status code to standardized error code
   */
  private mapStatusToErrorCode(status: number, message?: string): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        if (message?.toLowerCase().includes('validation')) {
          return ErrorCode.VALIDATION_ERROR;
        }
        return ErrorCode.BAD_REQUEST;

      case HttpStatus.UNAUTHORIZED:
        if (message?.toLowerCase().includes('token')) {
          if (message?.toLowerCase().includes('expired')) {
            return ErrorCode.TOKEN_EXPIRED;
          }
          return ErrorCode.INVALID_TOKEN;
        }
        return ErrorCode.UNAUTHORIZED;

      case HttpStatus.FORBIDDEN:
        if (message?.toLowerCase().includes('permission')) {
          return ErrorCode.INSUFFICIENT_PERMISSIONS;
        }
        return ErrorCode.FORBIDDEN;

      case HttpStatus.NOT_FOUND:
        // Try to extract resource type from message
        const lowerMessage = message?.toLowerCase() || '';
        if (lowerMessage.includes('journey')) {
          return ErrorCode.JOURNEY_NOT_FOUND;
        }
        if (lowerMessage.includes('contact')) {
          return ErrorCode.CONTACT_NOT_FOUND;
        }
        if (lowerMessage.includes('segment')) {
          return ErrorCode.SEGMENT_NOT_FOUND;
        }
        if (lowerMessage.includes('agent')) {
          return ErrorCode.AGENT_NOT_FOUND;
        }
        if (lowerMessage.includes('session')) {
          return ErrorCode.SESSION_NOT_FOUND;
        }
        return ErrorCode.RESOURCE_NOT_FOUND;

      case HttpStatus.CONFLICT:
        if (message?.toLowerCase().includes('email')) {
          return ErrorCode.DUPLICATE_EMAIL;
        }
        if (message?.toLowerCase().includes('already exists')) {
          return ErrorCode.RESOURCE_ALREADY_EXISTS;
        }
        return ErrorCode.CONFLICT;

      case HttpStatus.UNPROCESSABLE_ENTITY:
        if (message?.toLowerCase().includes('state')) {
          return ErrorCode.INVALID_STATE_TRANSITION;
        }
        return ErrorCode.BUSINESS_RULE_VIOLATION;

      case HttpStatus.GATEWAY_TIMEOUT:
      case HttpStatus.REQUEST_TIMEOUT:
        return ErrorCode.TIMEOUT_ERROR;

      case HttpStatus.BAD_GATEWAY:
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.EXTERNAL_SERVICE_ERROR;

      case HttpStatus.INTERNAL_SERVER_ERROR:
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  /**
   * Generate unique error ID for tracking
   */
  private generateErrorId(): string {
    return `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

