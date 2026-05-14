import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  monitoringWindowMs: number;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: number;
  totalRequests: number;
  failureRate: number;
}

@Injectable()
export class SegmentCircuitBreakerService {
  private readonly logger = new CustomLoggerService(
    SegmentCircuitBreakerService.name,
  );

  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime?: number;
  private lastRequestTime: number = Date.now();

  private readonly config: CircuitBreakerConfig = {
    failureThreshold: 5, // 5 consecutive failures
    recoveryTimeoutMs: 60000, // 1 minute
    monitoringWindowMs: 300000, // 5 minutes
  };

  constructor() {
    this.logger.log('Circuit breaker initialized with config:', this.config);
  }

  canExecute(): boolean {
    const currentTime = Date.now();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        if (
          currentTime - (this.lastFailureTime || 0) >
          this.config.recoveryTimeoutMs
        ) {
          this.state = CircuitState.HALF_OPEN;
          this.logger.log('Circuit breaker moved to HALF_OPEN state');
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return false;
    }
  }

  recordSuccess(): void {
    this.successCount++;
    this.lastRequestTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
      this.logger.log('Circuit breaker recovered, moved to CLOSED state');
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.lastRequestTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.logger.warn(
        `Circuit breaker opened due to ${this.failureCount} consecutive failures`,
      );
    }
  }

  async execute<T>(
    operation: () => Promise<T>,
    operationName: string = 'segment-computation',
  ): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(
        `Circuit breaker is ${this.state}, operation rejected: ${operationName}`,
      );
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  getStats(): CircuitBreakerStats {
    const totalRequests = this.successCount + this.failureCount;
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      totalRequests,
      failureRate: totalRequests > 0 ? this.failureCount / totalRequests : 0,
    };
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
    this.logger.log('Circuit breaker reset to CLOSED state');
  }
}
