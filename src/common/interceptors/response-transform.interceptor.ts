import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { StandardSuccessResponseDto, MetaDto } from '../dto/standard-response.dto';

/**
 * Global interceptor to transform all successful responses to StandardResponse format
 * Automatically wraps controller responses with success, data, and meta fields
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse();

    return next.handle().pipe(
      map((data) => {
        // Skip transformation if response is already in standard format
        if (this.isStandardResponse(data)) {
          return data;
        }

        // Skip transformation for 204 No Content
        if (response.statusCode === 204) {
          return data;
        }

        // Skip transformation for streaming responses
        if (response.headersSent) {
          return data;
        }

        // Build metadata
        const meta: MetaDto = {
          timestamp: new Date().toISOString(),
        };

        // Add request ID if available
        const requestId = request.headers['x-request-id'] as string;
        if (requestId) {
          meta.requestId = requestId;
        }

        // Build standard response
        const standardResponse: StandardSuccessResponseDto = {
          success: true,
          data: data ?? null,
          meta,
        };

        return standardResponse;
      }),
    );
  }

  /**
   * Check if response is already in standard format
   */
  private isStandardResponse(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    return (
      'success' in data &&
      'data' in data &&
      'meta' in data &&
      data.success === true
    );
  }
}

