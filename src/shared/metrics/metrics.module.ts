import { Global, Module } from '@nestjs/common';
import { PipelineMetricsService } from './pipeline-metrics.service';

@Global()
@Module({
  providers: [PipelineMetricsService],
  exports: [PipelineMetricsService],
})
export class PipelineMetricsModule {}
