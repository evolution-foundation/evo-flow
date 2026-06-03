import { RunMode } from './modules/processing/enums/run-mode.enum';
import { getProcessingConfig } from './modules/processing/config/processing.config';

export class AppFactory {
  static shouldStartHttpServer(): boolean {
    const config = getProcessingConfig();
    // Only API, SINGLE and EVENT_RECEIVER modes need HTTP server
    return [
      RunMode.SINGLE, // Development: everything
      RunMode.API, // Production: API gateway only
      RunMode.EVENT_RECEIVER, // Production: webhook receiver (story 3.1)
    ].includes(config.runMode);
  }

  static shouldStartEventWorker(): boolean {
    const config = getProcessingConfig();
    // Event worker modes
    return [
      RunMode.SINGLE, // Development: all workers
      RunMode.EVENT_WORKER, // Production: dedicated event worker
    ].includes(config.runMode);
  }

  static shouldStartSegmentWorker(): boolean {
    const config = getProcessingConfig();
    // Segment worker modes
    return [
      RunMode.SINGLE, // Development: all workers
      RunMode.SEGMENT_WORKER, // Production: dedicated segment worker
    ].includes(config.runMode);
  }

  static shouldStartJourneyWorker(): boolean {
    const config = getProcessingConfig();
    // Journey worker modes
    return [
      RunMode.SINGLE, // Development: all workers
      RunMode.TEMPORAL_WORKER, // Production: dedicated journey worker
    ].includes(config.runMode);
  }

  static shouldStartCampaignWorker(): boolean {
    const config = getProcessingConfig();
    // Campaign worker modes
    return [
      RunMode.SINGLE, // Development: all workers
      RunMode.CAMPAIGN_WORKER, // Production: dedicated campaign worker
    ].includes(config.runMode);
  }

  static shouldStartTemporalWorker(): boolean {
    // Backward-compatible helper used for TemporalModule import decisions
    return (
      AppFactory.shouldStartJourneyWorker() ||
      AppFactory.shouldStartCampaignWorker()
    );
  }

  static shouldStartCampaignPacker(): boolean {
    const config = getProcessingConfig();
    return [RunMode.SINGLE, RunMode.CAMPAIGN_PACKER].includes(config.runMode);
  }

  static shouldStartCampaignSender(): boolean {
    const config = getProcessingConfig();
    return [RunMode.SINGLE, RunMode.CAMPAIGN_SENDER].includes(config.runMode);
  }

  static shouldStartEventReceiver(): boolean {
    const config = getProcessingConfig();
    return [RunMode.SINGLE, RunMode.EVENT_RECEIVER].includes(config.runMode);
  }

  static shouldStartEventProcess(): boolean {
    const config = getProcessingConfig();
    return [RunMode.SINGLE, RunMode.EVENT_PROCESS].includes(config.runMode);
  }
}
