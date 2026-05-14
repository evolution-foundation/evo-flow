import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SegmentModeManagerService } from '../services/segment-mode-manager.service';

@Injectable()
export class SegmentApiGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private segmentModeManager: SegmentModeManagerService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Verificar se a API de segmentos está habilitada
    if (!this.segmentModeManager.isAPIEnabled()) {
      throw new ServiceUnavailableException({
        message: 'Segment API is disabled in current run mode',
        runMode: this.segmentModeManager.getRunMode(),
        suggestion:
          'Use SEGMENT_RUN_MODE=single or SEGMENT_RUN_MODE=segment-api',
      });
    }

    return true;
  }
}
