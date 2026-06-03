import { Injectable, ConsoleLogger, LogLevel, Logger } from '@nestjs/common';
import { getProcessingConfig } from '../../modules/processing/config/processing.config';
import { readCorrelationIdFromCls } from '../../shared/correlation/correlation.util';
import * as winston from 'winston';
import * as path from 'path';

@Injectable()
export class CustomLoggerService extends ConsoleLogger {
  private readonly runMode: string;
  private fileLogger: winston.Logger;

  constructor(context?: string) {
    super(context || 'CustomLogger');
    const config = getProcessingConfig();
    this.runMode = config.runMode;
    
    // Initialize Winston file logger
    this.fileLogger = winston.createLogger({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
          const ctx = context ? `[${context}]` : '';
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level.toUpperCase()}] ${ctx} [${this.runMode}] ${message}${metaStr}`;
        })
      ),
      transports: [
        // Performance log - for analyzing workflow timing
        new winston.transports.File({
          filename: path.join(process.cwd(), 'logs', 'performance.log'),
          level: 'info',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
        }),
        // Debug log - detailed debugging info
        new winston.transports.File({
          filename: path.join(process.cwd(), 'logs', 'debug.log'),
          level: 'debug',
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 3,
        }),
        // Error log
        new winston.transports.File({
          filename: path.join(process.cwd(), 'logs', 'error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
        })
      ]
    });
  }

  private addRunModeToMessage(message: any): string {
    // Convert message to string if it's not already
    const messageStr = typeof message === 'string' ? message : String(message);

    // Se a mensagem já contém o run mode, não adiciona novamente
    if (messageStr.includes(`[${this.runMode}]`)) {
      return messageStr;
    }

    return `[${this.runMode}] ${messageStr}`;
  }

  log(message: any, context?: string | object) {
    const correlationId = readCorrelationIdFromCls();
    if (typeof context === 'object') {
      // Se context é um objeto, converte para string e adiciona à mensagem
      const contextStr = JSON.stringify(context, null, 2);
      const logMessage = this.addRunModeToMessage(`${message}\n${contextStr}`);
      super.log(logMessage);
      // Also log to file
      this.fileLogger.info(message, { context, correlationId, ...context });
    } else {
      const logMessage = this.addRunModeToMessage(message);
      super.log(logMessage, context);
      // Also log to file
      this.fileLogger.info(message, { context, correlationId });
    }
  }

  error(
    message: any,
    traceOrContext?: string | object,
    context?: string | object,
  ) {
    // Se o segundo parâmetro é um objeto, é o context (não trace)
    if (typeof traceOrContext === 'object') {
      const contextStr = JSON.stringify(traceOrContext, null, 2);
      super.error(this.addRunModeToMessage(`${message}\n${contextStr}`));
    } else if (typeof context === 'object') {
      // Se o terceiro parâmetro é um objeto
      const contextStr = JSON.stringify(context, null, 2);
      super.error(
        this.addRunModeToMessage(`${message}\n${contextStr}`),
        traceOrContext,
      );
    } else {
      // Comportamento normal: trace como string
      super.error(
        this.addRunModeToMessage(message),
        traceOrContext,
        context as string,
      );
    }
  }

  warn(message: any, context?: string | object) {
    if (typeof context === 'object') {
      // Se context é um objeto, converte para string e adiciona à mensagem
      const contextStr = JSON.stringify(context, null, 2);
      super.warn(this.addRunModeToMessage(`${message}\n${contextStr}`));
    } else {
      super.warn(this.addRunModeToMessage(message), context);
    }
  }

  debug(message: any, context?: string | object) {
    // Skip DEBUG logs to reduce noise
    return;
  }

  verbose(message: any, context?: string | object) {
    // Skip VERBOSE logs to reduce noise
    return;
  }

  // Add specific method for performance logging (Temporal workflow analysis)
  logPerformance(message: string, data?: any) {
    const timestamp = new Date().toISOString();
    
    // Log to console
    super.log(`PERF: ${message}`, data);
    
    // Log to file with detailed timestamp
    this.fileLogger.info(message, {
      performance: true,
      timestamp,
      correlationId: readCorrelationIdFromCls(),
      ...data
    });
  }

  // Method to get file logger instance
  getFileLogger() {
    return this.fileLogger;
  }

  // Método estático para substituir o ConsoleLogger padrão globalmente
  static overrideGlobalLogger() {
    const config = getProcessingConfig();
    const runMode = config.runMode;

    // Sobrescrever o ConsoleLogger que é usado internamente pelo NestJS
    const originalLog = ConsoleLogger.prototype.log;
    const originalError = ConsoleLogger.prototype.error;
    const originalWarn = ConsoleLogger.prototype.warn;
    const originalDebug = ConsoleLogger.prototype.debug;
    const originalVerbose = ConsoleLogger.prototype.verbose;

    ConsoleLogger.prototype.log = function (
      message: any,
      context?: string | object,
    ) {
      let formattedMessage = message;
      if (typeof message === 'string' && !message.includes(`[${runMode}]`)) {
        formattedMessage = `[${runMode}] ${message}`;
      }

      if (typeof context === 'object' && context !== null) {
        const contextStr = JSON.stringify(context, null, 2);
        formattedMessage = `${formattedMessage}\n${contextStr}`;
        return originalLog.call(this, formattedMessage);
      }

      // Se context é undefined ou string vazia, não passa nada
      if (context === undefined || context === null || context === '') {
        return originalLog.call(this, formattedMessage);
      }

      return originalLog.call(this, formattedMessage, context);
    };

    ConsoleLogger.prototype.error = function (
      message: any,
      trace?: string,
      context?: string,
    ) {
      const formattedMessage =
        typeof message === 'string' && !message.includes(`[${runMode}]`)
          ? `[${runMode}] ${message}`
          : message;

      // Se trace e context são undefined, não passa nada
      if (trace === undefined && context === undefined) {
        return originalError.call(this, formattedMessage);
      } else if (context === undefined) {
        return originalError.call(this, formattedMessage, trace);
      }

      return originalError.call(this, formattedMessage, trace, context);
    };

    ConsoleLogger.prototype.warn = function (message: any, context?: string) {
      const formattedMessage =
        typeof message === 'string' && !message.includes(`[${runMode}]`)
          ? `[${runMode}] ${message}`
          : message;

      // Se context é undefined, não passa nada
      if (context === undefined || context === null || context === '') {
        return originalWarn.call(this, formattedMessage);
      }

      return originalWarn.call(this, formattedMessage, context);
    };

    ConsoleLogger.prototype.debug = function (message: any, context?: string) {
      const formattedMessage =
        typeof message === 'string' && !message.includes(`[${runMode}]`)
          ? `[${runMode}] ${message}`
          : message;

      // Se context é undefined, não passa nada
      if (context === undefined || context === null || context === '') {
        return originalDebug.call(this, formattedMessage);
      }

      return originalDebug.call(this, formattedMessage, context);
    };

    ConsoleLogger.prototype.verbose = function (
      message: any,
      context?: string,
    ) {
      const formattedMessage =
        typeof message === 'string' && !message.includes(`[${runMode}]`)
          ? `[${runMode}] ${message}`
          : message;

      // Se context é undefined, não passa nada
      if (context === undefined || context === null || context === '') {
        return originalVerbose.call(this, formattedMessage);
      }

      return originalVerbose.call(this, formattedMessage, context);
    };
  }
}
