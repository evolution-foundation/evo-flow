import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, NativeConnection } from '@temporalio/worker';
import { journeyExecutionActivities } from './activities/journey-execution.activities';
import { actionNodeActivities } from './activities/action-nodes.activities';
import { waitActivities } from './activities/wait.activities';
import { journeyTrackingActivities } from './activities/journey-tracking.activities';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { AppFactory } from '../../app-factory';
import { TEMPORAL_TASK_QUEUES } from './temporal-task-queues.constants';
import * as winston from 'winston';
import * as path from 'path';

@Injectable()
export class TemporalWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new CustomLoggerService(TemporalWorkerService.name);
  private worker: Worker | null = null;
  private connection: NativeConnection | null = null;
  private isInitializing: boolean = false;
  private temporalLogger: winston.Logger;
  private retryAttempts: number = 0;
  private maxRetries: number = 5;
  private retryTimeout: NodeJS.Timeout | null = null;

  constructor() {
    // Create dedicated Temporal logger
    this.temporalLogger = winston.createLogger({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr =
            Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level.toUpperCase()}] [TEMPORAL] ${message}${metaStr}`;
        }),
      ),
      transports: [
        new winston.transports.File({
          filename: path.join(process.cwd(), 'logs', 'temporal.log'),
          level: 'debug',
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 3,
        }),
      ],
    });

    // Override console methods to capture Temporal SDK logs
    this.interceptTemporalLogs();
  }

  private interceptTemporalLogs() {
    // Store original console methods
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    // Override console methods to capture Temporal logs
    console.log = (...args: any[]) => {
      const message = args.join(' ');
      // Check if this looks like a Temporal log
      if (
        message.includes('[INFO]') &&
        (message.includes('workflow') ||
          message.includes('activity') ||
          message.includes('Worker'))
      ) {
        this.temporalLogger.info(message);
      }
      // Also call original for console output
      originalLog.apply(console, args);
    };

    console.error = (...args: any[]) => {
      const message = args.join(' ');
      if (
        message.includes('[ERROR]') &&
        (message.includes('workflow') ||
          message.includes('activity') ||
          message.includes('Worker'))
      ) {
        this.temporalLogger.error(message);
      }
      originalError.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      const message = args.join(' ');
      if (
        message.includes('[WARN]') &&
        (message.includes('workflow') ||
          message.includes('activity') ||
          message.includes('Worker'))
      ) {
        this.temporalLogger.warn(message);
      }
      originalWarn.apply(console, args);
    };
  }

  async onModuleInit() {
    // Only start journey worker in journey-enabled modes
    if (!AppFactory.shouldStartJourneyWorker()) {
      this.logger.log(
        '⏭️  Journey Temporal worker disabled for current RUN_MODE',
      );
      return;
    }

    this.isInitializing = true;
    try {
      await this.startWorkerWithRetry();
    } catch (error) {
      const isDevelopment = process.env.NODE_ENV !== 'production';

      if (isDevelopment) {
        // In development, don't crash the app - log warning and retry in background
        this.logger.warn(
          '⚠️  Failed to start Temporal worker (non-fatal in development)',
          {
            error: error.message,
            temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
            message:
              'Application will continue running. Temporal worker will retry in background.',
          },
        );

        // Schedule retry in background
        this.scheduleRetry();
      } else {
        // In production, throw error to fail fast
        this.logger.error('Failed to start Temporal worker', {
          error: error.message,
          stack: error.stack,
        });
        throw error;
      }
    } finally {
      // Mark initialization as complete after a delay to avoid premature shutdown
      setTimeout(() => {
        this.isInitializing = false;
      }, 1000);
    }
  }

  async onModuleDestroy() {
    // Clear any pending retry timeouts
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    // Don't stop worker during initialization phase
    if (this.isInitializing) {
      this.logger.log(
        '🔧 Skipping worker shutdown during initialization phase',
      );
      return;
    }

    // Only stop worker if it was started
    if (!this.worker && !this.connection) {
      return;
    }

    try {
      await this.stopWorker();
    } catch (error) {
      this.logger.error('Error stopping Temporal worker', {
        error: error.message,
      });
    }
  }

  private async startWorkerWithRetry(): Promise<void> {
    const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
    const maxAttempts = this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(
          `Attempting to start Temporal worker (attempt ${attempt}/${maxAttempts})...`,
          {
            temporalAddress,
            taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
          },
        );

        await this.startWorker();
        this.retryAttempts = 0; // Reset on success
        return; // Success!
      } catch (error) {
        lastError = error as Error;
        this.retryAttempts = attempt;

        if (attempt < maxAttempts) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
          this.logger.warn(
            `Temporal connection failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
            {
              error: error.message,
              temporalAddress,
            },
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted
    throw (
      lastError ||
      new Error('Failed to start Temporal worker after all retries')
    );
  }

  private scheduleRetry(): void {
    // Clear any existing retry timeout
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }

    // Schedule retry after 10 seconds
    this.retryTimeout = setTimeout(async () => {
      if (this.worker || this.connection) {
        // Already connected, no need to retry
        return;
      }

      this.logger.log(
        '🔄 Retrying Temporal worker connection in background...',
      );
      try {
        await this.startWorkerWithRetry();
        this.logger.log(
          '✅ Temporal worker connected successfully after retry',
        );
      } catch (error) {
        this.logger.warn(
          '⚠️  Background retry failed, will retry again in 30s',
          {
            error: error.message,
          },
        );
        // Schedule another retry
        this.scheduleRetry();
      }
    }, 10000);
  }

  private async startWorker(): Promise<void> {
    const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

    this.logger.log('Starting Temporal worker...', {
      temporalAddress,
      taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
    });

    try {
      // Create connection to Temporal server
      this.connection = await NativeConnection.connect({
        address: temporalAddress,
      });

      // Create worker with workflows and activities - optimized for low latency
      this.worker = await Worker.create({
        connection: this.connection,
        namespace: 'default',
        taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
        workflowsPath: require.resolve(
          './workflows/journey-execution.workflow',
        ),
        activities: {
          // Journey execution activities
          ...journeyExecutionActivities,
          // Action node activities
          ...actionNodeActivities,
          // Wait activities
          ...waitActivities,
          // Journey tracking activities
          ...journeyTrackingActivities,
        },
        reuseV8Context: true, // Enable V8 context reuse for performance
        maxConcurrentActivityTaskExecutions: 200, // Increase concurrency
        maxConcurrentWorkflowTaskExecutions: 200, // Increase concurrency
        // Add performance optimizations
        stickyQueueScheduleToStartTimeout: '10s', // Reduce sticky queue timeout
        maxActivitiesPerSecond: 100, // Remove rate limiting
        maxTaskQueueActivitiesPerSecond: 1000, // Higher throughput
      });

      // this.logger.log('Temporal worker created successfully', {
      //   taskQueue: 'journey-execution',
      //   workflowsRegistered: ['JourneyExecutionWorkflow'],
      //   activitiesRegistered: [
      //     ...Object.keys(journeyExecutionActivities),
      //     ...Object.keys(actionNodeActivities),
      //     ...Object.keys(waitActivities),
      //     ...Object.keys(journeyTrackingActivities),
      //   ],
      // });

      // Start worker in background (non-blocking)
      this.startWorkerInBackground();
    } catch (error) {
      this.logger.error('Failed to create/start Temporal worker', {
        error: error.message,
        stack: error.stack,
        temporalAddress,
      });
      throw error;
    }
  }

  private startWorkerInBackground(): void {
    if (!this.worker) {
      this.logger.error('Cannot start worker - worker not initialized');
      return;
    }

    // Start worker in background without blocking
    this.worker
      .run()
      .then(() => {
        this.logger.log('✅ Temporal worker started and running');
      })
      .catch((error) => {
        this.logger.error('Temporal worker failed', {
          error: error.message,
          stack: error.stack,
        });
      });

    this.logger.log('🚀 Temporal worker is starting in background...');
  }

  private async stopWorker(): Promise<void> {
    this.logger.log('Stopping Temporal worker...');

    if (this.worker) {
      try {
        this.worker.shutdown();
        this.logger.log('Temporal worker shutdown initiated');
      } catch (error) {
        this.logger.error('Error shutting down Temporal worker', {
          error: error.message,
        });
      }
    }

    if (this.connection) {
      try {
        await this.connection.close();
        this.logger.log('Temporal connection closed');
      } catch (error) {
        this.logger.error('Error closing Temporal connection', {
          error: error.message,
        });
      }
    }
  }

  // Helper method to check if worker is running
  public isRunning(): boolean {
    return this.worker !== null && this.connection !== null;
  }

  // Helper method to get worker stats
  public getWorkerInfo(): any {
    if (!this.worker) {
      return {
        status: 'not_started',
        taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
      };
    }

    return {
      status: 'running',
      taskQueue: TEMPORAL_TASK_QUEUES.JOURNEY_EXECUTION,
      namespace: 'default',
      temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    };
  }
}
