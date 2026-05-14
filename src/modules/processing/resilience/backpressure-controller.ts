import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface BackpressureConfig {
  maxQueueSize: number;
  warningThreshold: number;
  criticalThreshold: number;
  recoveryThreshold: number;
  checkIntervalMs: number;
  enableAutoScaling: boolean;
}

export enum BackpressureState {
  NORMAL = 'NORMAL',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
  BLOCKED = 'BLOCKED',
}

export interface BackpressureStats {
  state: BackpressureState;
  queueSize: number;
  maxQueueSize: number;
  utilizationPercent: number;
  isAcceptingRequests: boolean;
  throttleDelayMs: number;
  droppedRequests: number;
  totalRequests: number;
}

@Injectable()
export class BackpressureController extends EventEmitter {
  private readonly logger = new CustomLoggerService(
    BackpressureController.name,
  );

  private state: BackpressureState = BackpressureState.NORMAL;
  private currentQueueSize = 0;
  private droppedRequests = 0;
  private totalRequests = 0;
  private checkTimer?: NodeJS.Timeout;

  private readonly config: BackpressureConfig;
  private readonly name: string;

  // Exponential backoff parameters
  private baseDelayMs = 10;
  private maxDelayMs = 5000;
  private backoffMultiplier = 1.5;
  private currentDelayMs = 0;

  constructor(name: string, config: Partial<BackpressureConfig> = {}) {
    super();

    this.name = name;
    this.config = {
      maxQueueSize: 10000,
      warningThreshold: 0.7, // 70%
      criticalThreshold: 0.85, // 85%
      recoveryThreshold: 0.5, // 50%
      checkIntervalMs: 1000, // 1 second
      enableAutoScaling: true,
      ...config,
    };

    this.logger.log(
      `Backpressure controller '${name}' initialized`,
      this.config,
    );
    this.startMonitoring();
  }

  async checkCapacity(): Promise<void> {
    this.totalRequests++;

    const utilizationPercent = this.currentQueueSize / this.config.maxQueueSize;

    // Update state based on utilization
    const previousState = this.state;

    if (utilizationPercent >= 1.0) {
      this.state = BackpressureState.BLOCKED;
    } else if (utilizationPercent >= this.config.criticalThreshold) {
      this.state = BackpressureState.CRITICAL;
    } else if (utilizationPercent >= this.config.warningThreshold) {
      this.state = BackpressureState.WARNING;
    } else if (utilizationPercent <= this.config.recoveryThreshold) {
      this.state = BackpressureState.NORMAL;
    }

    // Emit state change
    if (previousState !== this.state) {
      this.logger.log(
        `Backpressure state changed: ${previousState} -> ${this.state}`,
        {
          queueSize: this.currentQueueSize,
          utilization: `${Math.round(utilizationPercent * 100)}%`,
        },
      );

      this.emit('stateChanged', {
        name: this.name,
        from: previousState,
        to: this.state,
        queueSize: this.currentQueueSize,
        utilization: utilizationPercent,
      });
    }

    // Handle blocking
    if (this.state === BackpressureState.BLOCKED) {
      this.droppedRequests++;
      const error = new Error(
        `Backpressure: Queue full (${this.currentQueueSize}/${this.config.maxQueueSize})`,
      );
      this.emit('requestDropped', {
        name: this.name,
        queueSize: this.currentQueueSize,
      });
      throw error;
    }

    // Apply throttling delay
    await this.applyThrottling();
  }

  private async applyThrottling(): Promise<void> {
    let delayMs = 0;

    switch (this.state) {
      case BackpressureState.CRITICAL:
        delayMs = Math.min(
          this.baseDelayMs * Math.pow(this.backoffMultiplier, 4),
          this.maxDelayMs,
        );
        break;

      case BackpressureState.WARNING:
        delayMs = Math.min(
          this.baseDelayMs * Math.pow(this.backoffMultiplier, 2),
          this.maxDelayMs / 2,
        );
        break;

      case BackpressureState.NORMAL:
        delayMs = 0;
        break;
    }

    this.currentDelayMs = delayMs;

    if (delayMs > 0) {
      this.logger.debug(`Applying backpressure delay: ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  incrementQueue(): void {
    this.currentQueueSize++;
  }

  decrementQueue(): void {
    if (this.currentQueueSize > 0) {
      this.currentQueueSize--;
    }
  }

  setQueueSize(size: number): void {
    this.currentQueueSize = Math.max(0, size);
  }

  private startMonitoring(): void {
    this.checkTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.checkIntervalMs);
  }

  private performHealthCheck(): void {
    const stats = this.getStats();

    // Log periodic stats
    if (stats.state !== BackpressureState.NORMAL) {
      this.logger.debug(`Backpressure stats for '${this.name}':`, {
        state: stats.state,
        queueUtilization: `${stats.utilizationPercent.toFixed(1)}%`,
        throttleDelay: `${stats.throttleDelayMs}ms`,
        dropped: stats.droppedRequests,
      });
    }

    // Emit metrics
    this.emit('healthCheck', {
      name: this.name,
      stats,
      timestamp: new Date(),
    });

    // Auto-scaling suggestions (if enabled)
    if (this.config.enableAutoScaling) {
      this.suggestAutoScaling(stats);
    }
  }

  private suggestAutoScaling(stats: BackpressureStats): void {
    if (
      stats.state === BackpressureState.CRITICAL &&
      stats.utilizationPercent > 90
    ) {
      this.emit('scaleUpSuggested', {
        name: this.name,
        reason: 'High queue utilization',
        currentUtilization: stats.utilizationPercent,
        recommendedAction: 'Add more workers or increase queue capacity',
      });
    } else if (
      stats.state === BackpressureState.NORMAL &&
      stats.utilizationPercent < 20
    ) {
      this.emit('scaleDownSuggested', {
        name: this.name,
        reason: 'Low queue utilization',
        currentUtilization: stats.utilizationPercent,
        recommendedAction: 'Consider reducing worker count',
      });
    }
  }

  getStats(): BackpressureStats {
    const utilizationPercent =
      Math.round(
        (this.currentQueueSize / this.config.maxQueueSize) * 100 * 10,
      ) / 10;

    return {
      state: this.state,
      queueSize: this.currentQueueSize,
      maxQueueSize: this.config.maxQueueSize,
      utilizationPercent,
      isAcceptingRequests: this.state !== BackpressureState.BLOCKED,
      throttleDelayMs: this.currentDelayMs,
      droppedRequests: this.droppedRequests,
      totalRequests: this.totalRequests,
    };
  }

  // Manual controls
  pause(): void {
    this.state = BackpressureState.BLOCKED;
    this.logger.log(`Backpressure controller '${this.name}' manually paused`);
    this.emit('manuallyPaused', { name: this.name });
  }

  resume(): void {
    this.state = BackpressureState.NORMAL;
    this.currentDelayMs = 0;
    this.logger.log(`Backpressure controller '${this.name}' manually resumed`);
    this.emit('manuallyResumed', { name: this.name });
  }

  reset(): void {
    this.state = BackpressureState.NORMAL;
    this.currentQueueSize = 0;
    this.droppedRequests = 0;
    this.totalRequests = 0;
    this.currentDelayMs = 0;

    this.logger.log(`Backpressure controller '${this.name}' reset`);
    this.emit('reset', { name: this.name });
  }

  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    this.logger.log(`Backpressure controller '${this.name}' destroyed`);
    this.emit('destroyed', { name: this.name });
  }
}
