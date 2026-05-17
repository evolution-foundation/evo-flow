import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RuntimeContextMiddleware } from './runtime-context.middleware';

@Module({
  providers: [RuntimeContextMiddleware],
  exports: [RuntimeContextMiddleware],
})
export class RuntimeContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RuntimeContextMiddleware).forRoutes('*');
  }
}
