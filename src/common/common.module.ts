import { Global, Module } from '@nestjs/common';
import { CustomLoggerService } from './services/custom-logger.service';
import { ResponseTransformInterceptor } from './interceptors/response-transform.interceptor';
import { HttpExceptionFilter } from './filters/http-exception.filter';

@Global()
@Module({
  providers: [
    CustomLoggerService,
    ResponseTransformInterceptor,
    HttpExceptionFilter,
  ],
  exports: [
    CustomLoggerService,
    ResponseTransformInterceptor,
    HttpExceptionFilter,
  ],
})
export class CommonModule {}
