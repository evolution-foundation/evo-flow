import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import {
  StandardSuccessResponseDto,
  MetaDto,
} from '../dto/standard-response.dto';
import { SKIP_RESPONSE_TRANSFORM } from '../decorators/skip-response-transform.decorator';

/**
 * Global interceptor to transform all successful responses to StandardResponse format
 * Automatically wraps controller responses with success, data, and meta fields
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  constructor(private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse();

    // Endpoints marked @SkipResponseTransform() (e.g. health/readiness probes)
    // must return a raw, un-wrapped body so their contract is identical across
    // RUN_MODEs — worker modes don't even register this interceptor (EVO-1226).
    const skip = this.reflector?.getAllAndOverride<boolean>(
      SKIP_RESPONSE_TRANSFORM,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return next.handle();
    }

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
