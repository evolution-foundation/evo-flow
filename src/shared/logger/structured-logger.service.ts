import { Injectable, LoggerService } from '@nestjs/common';
import { readCorrelationIdFromCls } from '../correlation/correlation.util';

type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'verbose';

/**
 * PII fields that must never reach INFO-level logs (Architecture enforcement
 * guideline). Matched case-insensitively against context keys.
 */
const PII_KEYS = new Set([
  'phone',
  'recipientphone',
  'email',
  'recipientemail',
  'templatebody',
  'body',
  'message',
  'content',
]);

const REDACTED = '[REDACTED]';

export interface StructuredLogContext {
  context?: string;
  campaignId?: string;
  [key: string]: unknown;
}

/**
 * JSON line logger for the distributed pipeline (FR38, NFR32). Every record
 * carries `timestamp` (ISO 8601), `service` (= RUN_MODE), `level`,
 * `correlationId` (from the request-scoped AsyncLocalStorage maintained by the
 * correlation infra, story 2.5), plus optional `campaignId` and `context`.
 *
 * Drop-in for the Nest `LoggerService` so it can back `app.useLogger(...)` and
 * be injected wherever a logger is expected.
 */
@Injectable()
export class StructuredLoggerService implements LoggerService {
  private readonly service = process.env.RUN_MODE ?? 'unknown';

  log(message: unknown, context?: string | StructuredLogContext): void {
    this.emit('info', message, context);
  }

  error(
    message: unknown,
    traceOrContext?: string | StructuredLogContext,
    context?: string | StructuredLogContext,
  ): void {
    const trace =
      typeof traceOrContext === 'string' && context !== undefined
        ? traceOrContext
        : undefined;
    const ctx = trace ? context : (traceOrContext ?? context);
    this.emit('error', message, ctx, trace);
  }

  warn(message: unknown, context?: string | StructuredLogContext): void {
    this.emit('warn', message, context);
  }

  debug(message: unknown, context?: string | StructuredLogContext): void {
    this.emit('debug', message, context);
  }

  verbose(message: unknown, context?: string | StructuredLogContext): void {
    this.emit('verbose', message, context);
  }

  private emit(
    level: LogLevel,
    message: unknown,
    context?: string | StructuredLogContext,
    trace?: string,
  ): void {
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      service: this.service,
      level,
      correlationId: readCorrelationIdFromCls(),
      msg: typeof message === 'string' ? message : this.stringify(message),
    };

    if (typeof context === 'string') {
      record.context = context;
    } else if (context && typeof context === 'object') {
      const { context: ctxName, campaignId, ...rest } = context;
      if (ctxName) record.context = ctxName;
      if (campaignId) record.campaignId = campaignId;
      const safeRest = this.redact(rest) as Record<string, unknown>;
      if (Object.keys(safeRest).length > 0) record.meta = safeRest;
    }

    if (trace) record.trace = trace;

    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  /**
   * Recursively replace values under PII keys with `[REDACTED]`. Recurses into
   * nested objects and arrays so PII buried below the top level (e.g.
   * `{ contact: { phone } }`) is still scrubbed. Depth-bounded to stay cheap and
   * to avoid blowing up on accidental circular structures.
   */
  private redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PII_KEYS.has(key.toLowerCase())
        ? REDACTED
        : this.redact(val, depth + 1);
    }
    return out;
  }

  private stringify(message: unknown): string {
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}
