import { ClsServiceManager } from 'nestjs-cls';
import { CORRELATION_CLS_KEY } from './correlation.constants';

/**
 * Reads the current correlation id from CLS without DI — for use in code that
 * is not instantiated by the Nest container (e.g. the logger, raw axios
 * interceptors). Returns undefined when there is no active request context.
 */
export function readCorrelationIdFromCls(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    if (!cls?.isActive()) return undefined;
    return cls.get<string>(CORRELATION_CLS_KEY);
  } catch {
    return undefined;
  }
}
