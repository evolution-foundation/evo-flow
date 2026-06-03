import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { CORRELATION_HEADER } from './correlation.constants';
import { readCorrelationIdFromCls } from './correlation.util';

/**
 * Registers a request interceptor that injects the current correlation id as
 * `X-Correlation-Id` on outbound calls. Apply to the default axios instance
 * (covers raw `axios.*` callers) and/or to any `axios.create()` instance —
 * interceptors do not propagate from the default to created instances.
 */
export function applyCorrelationHeader(instance: AxiosInstance): void {
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const correlationId = readCorrelationIdFromCls();
    if (correlationId) {
      config.headers.set(CORRELATION_HEADER, correlationId);
    }
    return config;
  });
}
