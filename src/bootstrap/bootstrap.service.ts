import { Injectable } from '@nestjs/common';
import { RunMode } from '../modules/processing/enums/run-mode.enum';
import { getProcessingConfig } from '../modules/processing/config/processing.config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class BootstrapService {
  private readonly logger = new CustomLoggerService(BootstrapService.name);
  private readonly config = getProcessingConfig();

  shouldLoadEventApi(): boolean {
    return (
      this.config.runMode === RunMode.SINGLE ||
      this.config.runMode === RunMode.API
    );
  }

  shouldLoadEventProcessors(): boolean {
    return (
      this.config.runMode === RunMode.SINGLE ||
      this.config.runMode === RunMode.EVENT_WORKER
    );
  }

  shouldLoadGeneralControllers(): boolean {
    // Controllers gerais (health, info, etc) sempre disponíveis
    return (
      this.config.runMode === RunMode.SINGLE ||
      this.config.runMode === RunMode.API
    );
  }

  getRunInfo() {
    return {
      runMode: this.config.runMode,
      components: {
        eventApi: this.shouldLoadEventApi(),
        eventProcessors: this.shouldLoadEventProcessors(),
        generalControllers: this.shouldLoadGeneralControllers(),
      },
      config: {
        queueMode: this.config.queueMode,
        writeMode: this.config.writeMode,
      },
    };
  }

  logStartupInfo() {
    this.logger.log('='.repeat(60));
    this.logger.log('🚀 EVO CAMPAIGN SERVICE STARTING');
    this.logger.log('='.repeat(60));
    this.logger.log(`Run Mode: ${this.config.runMode.toUpperCase()}`);
    this.logger.log(`Queue Mode: ${this.config.queueMode.toUpperCase()}`);
    this.logger.log(`Write Mode: ${this.config.writeMode.toUpperCase()}`);
    this.logger.log('');

    const components = this.getRunInfo().components;
    this.logger.log('📦 Components Loading:');
    this.logger.log(`  • Event API: ${components.eventApi ? '✅' : '❌'}`);
    this.logger.log(
      `  • Event Processors: ${components.eventProcessors ? '✅' : '❌'}`,
    );
    this.logger.log(
      `  • General Controllers: ${components.generalControllers ? '✅' : '❌'}`,
    );
    this.logger.log('');

    switch (this.config.runMode) {
      case RunMode.SINGLE:
        this.logger.log(
          '🔄 SINGLE MODE: Running API + Workers together (development)',
        );
        break;
      case RunMode.API:
        this.logger.log(
          '📥 API MODE: Gateway for all APIs (production frontend)',
        );
        break;
      case RunMode.EVENT_WORKER:
        this.logger.log(
          '⚡ EVENT WORKER MODE: Processing events only (production backend)',
        );
        break;
      case RunMode.SEGMENT_WORKER:
        this.logger.log(
          '📊 SEGMENT WORKER MODE: Processing segments only (production backend)',
        );
        break;
      case RunMode.TEMPORAL_WORKER:
        this.logger.log(
          '🚀 TEMPORAL WORKER MODE: Journey execution only (production backend)',
        );
        break;
      case RunMode.CAMPAIGN_WORKER:
        this.logger.log(
          '📣 CAMPAIGN WORKER MODE: Campaign execution only (production backend)',
        );
        break;
      case RunMode.CAMPAIGN_PACKER:
        this.logger.log(
          '📦 CAMPAIGN PACKER MODE: Audience materialization stage (stub — module pending)',
        );
        break;
      case RunMode.CAMPAIGN_SENDER:
        this.logger.log(
          '📤 CAMPAIGN SENDER MODE: Dispatch stage (stub — module pending)',
        );
        break;
      case RunMode.EVENT_RECEIVER:
        this.logger.log(
          '📡 EVENT RECEIVER MODE: Inbound webhook receiver (POST /webhooks/*)',
        );
        break;
      case RunMode.EVENT_PROCESS:
        this.logger.log(
          '⚙️  EVENT PROCESS MODE: Broker-driven event processor (stub — module pending)',
        );
        break;
    }

    this.logger.log('='.repeat(60));
  }
}
