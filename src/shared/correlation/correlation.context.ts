import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import {
  CORRELATION_CLS_KEY,
  isValidCorrelationId,
} from './correlation.constants';

/**
 * Request-scoped correlation id, backed by the shared nestjs-cls store
 * (`correlationId` key) — coexists with the existing `transactionId`.
 */
@Injectable()
export class CorrelationContext {
  constructor(private readonly cls: ClsService) {}

  getCorrelationId(): string | undefined {
    if (!this.cls.isActive()) return undefined;
    return this.cls.get<string>(CORRELATION_CLS_KEY);
  }

  setCorrelationId(id: string): void {
    if (this.cls.isActive()) this.cls.set(CORRELATION_CLS_KEY, id);
  }

  runWithCorrelationId<T>(id: string, fn: () => T): T {
    return this.cls.run(() => {
      this.cls.set(CORRELATION_CLS_KEY, id);
      return fn();
    });
  }

  /**
   * Preserve a valid inbound correlation id (cross-service chaining) or mint a
   * fresh UUID v4. Invalid/unsafe inbound values are replaced, not propagated.
   */
  resolveIncoming(incoming?: string | string[]): string {
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    return isValidCorrelationId(raw) ? raw : randomUUID();
  }
}
