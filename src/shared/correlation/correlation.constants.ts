export const CORRELATION_HEADER = 'x-correlation-id';
export const CORRELATION_CLS_KEY = 'correlationId';
export const MAX_CORRELATION_ID_LENGTH = 128;

// Incoming X-Correlation-Id is caller-controlled, so an inbound value is only
// preserved when it is a short, safe token (no CRLF / control chars). This
// blocks log- and header-injection through the header; anything else is
// replaced by a freshly generated UUID.
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CORRELATION_ID.test(value);
}
