import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
  expectedFailureRate: number;
  minimumThroughput: number;
  timeout: number;
}

export interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  failureRate: number;
  lastFailureTime?: Date;
  nextRetryTime?: Date;
  consecutiveFailures: number;
}

@Injectable()
export class CircuitBreaker extends EventEmitter {
  private readonly logger = new CustomLoggerService(CircuitBreaker.name);

  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private consecutiveFailures = 0;
  private lastFailureTime?: Date;
  private nextRetryTime?: Date;
  private stateChanged: Date = new Date();

  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  // Sliding window for failure rate calculation
  private requestWindow: Array<{ timestamp: Date; failed: boolean }> = [];

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    super();

    this.name = name;
    this.config = {
      failureThreshold: 5,
      recoveryTimeout: 60000, // 1 minute
      monitoringPeriod: 60000, // 1 minute
      expectedFailureRate: 0.5, // 50%
      minimumThroughput: 10,
      timeout: 10000, // 10 seconds
      ...config,
    };

    this.logger.log(`Circuit breaker '${name}' initialized`, this.config);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.canAttemptReset()) {
        this.setState(CircuitBreakerState.HALF_OPEN);
        this.logger.log(
          `Circuit breaker '${this.name}' transitioning to HALF_OPEN`,
        );
      } else {
        const error = new Error(`Circuit breaker '${this.name}' is OPEN`);
        this.emit('rejected', { name: this.name, reason: 'circuit_open' });
        throw error;
      }
    }

    // Execute operation with timeout
    try {
      const result = await Promise.race([operation(), this.timeoutPromise()]);

      this.onSuccess();
      return result as T;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private timeoutPromise<T>(): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);
    });
  }

  private onSuccess(): void {
    this.successCount++;
    this.consecutiveFailures = 0;
    this.addToWindow(false);

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.setState(CircuitBreakerState.CLOSED);
      this.logger.log(
        `Circuit breaker '${this.name}' closed after successful recovery`,
      );
      this.emit('closed', { name: this.name });
    }

    this.cleanupWindow();
  }

  private onFailure(error: any): void {
    this.failureCount++;
    this.consecutiveFailures++;
    this.lastFailureTime = new Date();
    this.addToWindow(true);

    this.logger.debug(`Circuit breaker '${this.name}' failure:`, {
      error: error.message,
      consecutiveFailures: this.consecutiveFailures,
      state: this.state,
    });

    // Check if we should open the circuit
    if (this.shouldOpenCircuit()) {
      this.setState(CircuitBreakerState.OPEN);
      this.nextRetryTime = new Date(Date.now() + this.config.recoveryTimeout);

      this.logger.warn(`Circuit breaker '${this.name}' opened`, {
        consecutiveFailures: this.consecutiveFailures,
        failureRate: this.getFailureRate(),
        nextRetryTime: this.nextRetryTime,
      });

      this.emit('opened', {
        name: this.name,
        failureCount: this.failureCount,
        failureRate: this.getFailureRate(),
      });
    }

    this.cleanupWindow();
  }

  private shouldOpenCircuit(): boolean {
    // Always open if consecutive failures exceed threshold
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      return true;
    }

    // Check failure rate over monitoring period
    const totalRequests = this.requestWindow.length;
    if (totalRequests < this.config.minimumThroughput) {
      return false; // Not enough data
    }

    const failureRate = this.getFailureRate();
    return failureRate >= this.config.expectedFailureRate;
  }

  private canAttemptReset(): boolean {
    if (!this.nextRetryTime) {
      return true;
    }

    return new Date() >= this.nextRetryTime;
  }

  private setState(newState: CircuitBreakerState): void {
    const previousState = this.state;
    this.state = newState;
    this.stateChanged = new Date();

    if (previousState !== newState) {
      this.emit('stateChanged', {
        name: this.name,
        from: previousState,
        to: newState,
        timestamp: this.stateChanged,
      });
    }
  }

  private addToWindow(failed: boolean): void {
    this.requestWindow.push({
      timestamp: new Date(),
      failed,
    });
  }

  private cleanupWindow(): void {
    const cutoff = new Date(Date.now() - this.config.monitoringPeriod);
    this.requestWindow = this.requestWindow.filter(
      (req) => req.timestamp > cutoff,
    );
  }

  private getFailureRate(): number {
    if (this.requestWindow.length === 0) {
      return 0;
    }

    const failures = this.requestWindow.filter((req) => req.failed).length;
    return failures / this.requestWindow.length;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.failureCount + this.successCount,
      failureRate: this.getFailureRate(),
      lastFailureTime: this.lastFailureTime,
      nextRetryTime: this.nextRetryTime,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  reset(): void {
    this.setState(CircuitBreakerState.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.consecutiveFailures = 0;
    this.lastFailureTime = undefined;
    this.nextRetryTime = undefined;
    this.requestWindow = [];

    this.logger.log(`Circuit breaker '${this.name}' manually reset`);
    this.emit('reset', { name: this.name });
  }

  // Health check method
  isHealthy(): boolean {
    return this.state === CircuitBreakerState.CLOSED;
  }

  // Force open for maintenance
  forceOpen(): void {
    this.setState(CircuitBreakerState.OPEN);
    this.nextRetryTime = new Date(Date.now() + this.config.recoveryTimeout);
    this.logger.log(
      `Circuit breaker '${this.name}' force opened for maintenance`,
    );
    this.emit('forceOpened', { name: this.name });
  }
}
