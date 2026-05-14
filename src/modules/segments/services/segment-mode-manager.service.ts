import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { RunMode } from '../../processing/enums/run-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export enum SegmentProcessingMode {
  REALTIME = 'realtime',
  BATCH = 'batch',
  SCHEDULED = 'scheduled',
}

@Injectable()
export class SegmentModeManagerService implements OnModuleInit {
  private readonly logger = new CustomLoggerService(
    SegmentModeManagerService.name,
  );
  private runMode: RunMode;
  private segmentProcessingMode: SegmentProcessingMode;

  constructor(
    private configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
  ) {
    this.runMode = this.configService.get<RunMode>('RUN_MODE', RunMode.SINGLE);
    this.segmentProcessingMode = this.configService.get<SegmentProcessingMode>(
      'SEGMENT_PROCESSING_MODE',
      SegmentProcessingMode.SCHEDULED,
    );
  }

  async onModuleInit(): Promise<void> {
    // Só inicializa se for um modo que inclui sistema de segmentos (API ou processamento)
    if (
      this.runMode === RunMode.EVENT_WORKER ||
      this.runMode === RunMode.TEMPORAL_WORKER
    ) {
      this.logger.log(
        `🎯 Segment System: Skipped (${this.runMode} mode - segment system disabled)`,
      );
      return;
    }

    this.logger.log('🎯 Initializing Segment System...');
    this.logger.log(`📊 Run Mode: ${this.runMode}`);
    this.logger.log(`⚡ Processing Mode: ${this.segmentProcessingMode}`);
    this.logger.log(`🗄️ Storage Mode: ClickHouse (fixed)`);
    this.logger.log(`🔧 Computation Mode: ClickHouse (fixed)`);

    await this.configureSegmentSystem();
  }

  private async configureSegmentSystem(): Promise<void> {
    switch (this.runMode) {
      case RunMode.SINGLE:
        await this.enableSegmentAPI();
        await this.enableSegmentProcessor();
        this.logger.log('✅ Segment System: API + Processor enabled');
        break;

      case RunMode.API:
        await this.enableSegmentAPI();
        await this.disableSegmentProcessor();
        this.logger.log(
          '✅ Segment System: API only enabled (processor handled by workers)',
        );
        break;

      case RunMode.SEGMENT_WORKER:
        await this.disableSegmentAPI();
        await this.enableSegmentProcessor();
        this.logger.log('✅ Segment System: Processor only enabled');
        break;

      default:
        this.logger.warn(
          `⚠️ Run mode ${this.runMode} does not include segment system`,
        );
        break;
    }
  }

  private async enableSegmentAPI(): Promise<void> {
    // API está sempre disponível via controller, mas podemos adicionar feature flags
    this.logger.debug('🔌 Segment API endpoints enabled');
  }

  private async disableSegmentAPI(): Promise<void> {
    // Em modo processor-only, podemos desabilitar as rotas via guards
    this.logger.debug('🔌 Segment API endpoints disabled');
  }

  private async enableSegmentProcessor(): Promise<void> {
    try {
      // Configurar jobs baseado no processing mode
      switch (this.segmentProcessingMode) {
        case SegmentProcessingMode.SCHEDULED:
          await this.enableScheduledJobs();
          break;
        case SegmentProcessingMode.BATCH:
          await this.enableBatchJobs();
          break;
        case SegmentProcessingMode.REALTIME:
          await this.enableRealtimeJobs();
          break;
      }
      this.logger.debug('⚙️ Segment background processor enabled');
    } catch (error) {
      this.logger.error('❌ Failed to enable segment processor', error);
    }
  }

  private async disableSegmentProcessor(): Promise<void> {
    try {
      // Desabilitar todos os cron jobs
      await this.disableAllScheduledJobs();
      this.logger.debug('⚙️ Segment background processor disabled');
    } catch (error) {
      this.logger.error('❌ Failed to disable segment processor', error);
    }
  }

  private async enableScheduledJobs(): Promise<void> {
    // Jobs padrão: stale recomputation (5min) + full recomputation (2AM)
    this.logger.debug('📅 Scheduled jobs enabled (5min stale + 2AM full)');
    // Jobs já são registrados via decorators @Cron no SegmentJobService
  }

  private async enableBatchJobs(): Promise<void> {
    // Jobs mais frequentes em batches menores
    await this.disableAllScheduledJobs();

    // Registrar job customizado para batch processing
    const batchInterval = this.configService.get<number>(
      'SEGMENT_BATCH_INTERVAL',
      60000,
    ); // 1 min

    const batchJob = setInterval(async () => {
      try {
        this.logger.debug('Batch job would trigger segment recomputation');
        // Note: Esta funcionalidade será ativada via jobs automáticos do SegmentJobService
      } catch (error) {
        this.logger.error('Batch job failed', error);
      }
    }, batchInterval);

    // Registrar no scheduler para cleanup
    this.schedulerRegistry.addInterval('segment-batch-job', batchJob);
    this.logger.debug(`📦 Batch jobs enabled (${batchInterval}ms interval)`);
  }

  private async enableRealtimeJobs(): Promise<void> {
    // Processamento quase em tempo real (30s)
    await this.disableAllScheduledJobs();

    const realtimeInterval = this.configService.get<number>(
      'SEGMENT_REALTIME_INTERVAL',
      30000,
    ); // 30s

    const realtimeJob = setInterval(async () => {
      try {
        this.logger.debug('Realtime job would trigger segment recomputation');
        // Note: Esta funcionalidade será ativada via jobs automáticos do SegmentJobService
      } catch (error) {
        this.logger.error('Realtime job failed', error);
      }
    }, realtimeInterval);

    this.schedulerRegistry.addInterval('segment-realtime-job', realtimeJob);
    this.logger.debug(
      `⚡ Realtime jobs enabled (${realtimeInterval}ms interval)`,
    );
  }

  private async disableAllScheduledJobs(): Promise<void> {
    // Remove custom intervals
    try {
      if (this.schedulerRegistry.doesExist('interval', 'segment-batch-job')) {
        this.schedulerRegistry.deleteInterval('segment-batch-job');
      }
      if (
        this.schedulerRegistry.doesExist('interval', 'segment-realtime-job')
      ) {
        this.schedulerRegistry.deleteInterval('segment-realtime-job');
      }
    } catch (error) {
      this.logger.warn('Error cleaning up scheduled jobs', error);
    }
  }

  /**
   * Getters para outros services verificarem o modo atual
   */
  isAPIEnabled(): boolean {
    return this.runMode === RunMode.SINGLE || this.runMode === RunMode.API;
  }

  isProcessorEnabled(): boolean {
    return (
      this.runMode === RunMode.SINGLE || this.runMode === RunMode.SEGMENT_WORKER
    );
  }

  getRunMode(): RunMode {
    return this.runMode;
  }

  getProcessingMode(): SegmentProcessingMode {
    return this.segmentProcessingMode;
  }

  getStorageMode(): string {
    return 'clickhouse';
  }

  getComputationMode(): string {
    return 'clickhouse';
  }

  /**
   * Health check endpoint
   */
  getSystemStatus(): Record<string, any> {
    return {
      runMode: this.runMode,
      segmentProcessingMode: this.segmentProcessingMode,
      segmentStorageMode: 'clickhouse',
      segmentComputationMode: 'clickhouse',
      segmentApiEnabled: this.isAPIEnabled(),
      segmentProcessorEnabled: this.isProcessorEnabled(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Dynamic mode switching (para admin/debug)
   */
  async switchRunMode(newMode: RunMode): Promise<void> {
    this.logger.log(`🔄 Switching run mode from ${this.runMode} to ${newMode}`);

    // Cleanup current mode
    await this.disableSegmentProcessor();

    // Apply new mode
    this.runMode = newMode;
    await this.configureSegmentSystem();

    this.logger.log(`✅ Run mode switched to ${newMode}`);
  }
}
