import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunMode } from '../../modules/processing/enums/run-mode.enum';
import { CustomLoggerService } from './custom-logger.service';

@Injectable()
export class RunModeManagerService implements OnModuleInit {
  private readonly logger = new CustomLoggerService(RunModeManagerService.name);
  private runMode: RunMode;

  constructor(private configService: ConfigService) {
    this.runMode = this.configService.get<RunMode>('RUN_MODE', RunMode.SINGLE);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('========================================');
    this.logger.log('🚀 EVO CAMPAIGN - STARTING');
    this.logger.log(`📊 Run Mode: ${this.runMode}`);
    this.logger.log('========================================');

    this.logModeCapabilities();
  }

  private logModeCapabilities(): void {
    switch (this.runMode) {
      case RunMode.SINGLE:
        this.logger.log('✅ HTTP APIs: ENABLED');
        this.logger.log('✅ Event Worker: ENABLED');
        this.logger.log('✅ Segment Worker: ENABLED');
        this.logger.log('✅ Journey Worker: ENABLED');
        this.logger.log('Mode: All-in-one (Development)');
        break;

      case RunMode.API:
        this.logger.log('✅ HTTP APIs: ENABLED');
        this.logger.log('❌ Event Worker: DISABLED');
        this.logger.log('❌ Segment Worker: DISABLED');
        this.logger.log('❌ Journey Worker: DISABLED');
        this.logger.log('Mode: API Gateway Only');
        break;

      case RunMode.EVENT_WORKER:
        this.logger.log('❌ HTTP APIs: DISABLED');
        this.logger.log('✅ Event Worker: ENABLED');
        this.logger.log('❌ Segment Worker: DISABLED');
        this.logger.log('❌ Journey Worker: DISABLED');
        this.logger.log('Mode: Event Processing Only');
        break;

      case RunMode.SEGMENT_WORKER:
        this.logger.log('❌ HTTP APIs: DISABLED');
        this.logger.log('❌ Event Worker: DISABLED');
        this.logger.log('✅ Segment Worker: ENABLED');
        this.logger.log('❌ Journey Worker: DISABLED');
        this.logger.log('Mode: Segment Processing Only');
        break;

      case RunMode.TEMPORAL_WORKER:
        this.logger.log('❌ HTTP APIs: DISABLED');
        this.logger.log('❌ Event Worker: DISABLED');
        this.logger.log('❌ Segment Worker: DISABLED');
        this.logger.log('✅ Journey Worker: ENABLED');
        this.logger.log('Mode: Journey Execution Only');
        break;

      default:
        this.logger.warn(
          `⚠️ Unknown run mode: ${this.runMode}, defaulting to SINGLE`,
        );
        this.runMode = RunMode.SINGLE;
        this.logModeCapabilities();
    }
  }

  getRunMode(): RunMode {
    return this.runMode;
  }

  // Component checks aligned with AppFactory
  isHttpServerEnabled(): boolean {
    return this.runMode === RunMode.SINGLE || this.runMode === RunMode.API;
  }

  isEventWorkerEnabled(): boolean {
    return (
      this.runMode === RunMode.SINGLE || this.runMode === RunMode.EVENT_WORKER
    );
  }

  isSegmentWorkerEnabled(): boolean {
    return (
      this.runMode === RunMode.SINGLE || this.runMode === RunMode.SEGMENT_WORKER
    );
  }

  isTemporalWorkerEnabled(): boolean {
    return (
      this.runMode === RunMode.SINGLE ||
      this.runMode === RunMode.TEMPORAL_WORKER
    );
  }

  // Legacy compatibility methods (deprecated)
  isEventApiEnabled(): boolean {
    return this.isHttpServerEnabled();
  }

  isSegmentApiEnabled(): boolean {
    return this.isHttpServerEnabled();
  }

  isSegmentsSystemActive(): boolean {
    return this.isSegmentApiEnabled() || this.isSegmentWorkerEnabled();
  }

  isEventsSystemActive(): boolean {
    return this.isEventApiEnabled() || this.isEventWorkerEnabled();
  }

  // Health check
  getSystemStatus(): Record<string, any> {
    return {
      runMode: this.runMode,
      capabilities: {
        httpServer: this.isHttpServerEnabled(),
        eventWorker: this.isEventWorkerEnabled(),
        segmentWorker: this.isSegmentWorkerEnabled(),
        temporalWorker: this.isTemporalWorkerEnabled(),
      },
      systems: {
        events: this.isEventsSystemActive(),
        segments: this.isSegmentsSystemActive(),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
