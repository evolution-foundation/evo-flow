import { Global, Module } from '@nestjs/common';
import { CorrelationContext } from './correlation.context';

@Global()
@Module({
  providers: [CorrelationContext],
  exports: [CorrelationContext],
})
export class CorrelationModule {}
