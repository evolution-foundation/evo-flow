/**
 * Classifies a database error as deterministic (fails identically on every
 * redelivery — e.g. malformed SQL, bad data) vs transient (may succeed on
 * retry — e.g. a dropped connection). A broker consumer uses this at its
 * ack/nack boundary to avoid requeueing a poison message forever.
 *
 * Keyed off the PostgreSQL SQLSTATE class (first two chars of the 5-char code):
 *  - deterministic: 42 (syntax error / access rule violation),
 *    22 (data exception)
 *  - transient: 08 (connection exception), 53 (insufficient resources),
 *    57 (operator intervention), 40 (transaction rollback / deadlock)
 *
 * Unknown codes default to NOT deterministic: requeueing a recoverable failure
 * is safer than dropping it. The residual risk (an unclassified deterministic
 * error that loops) is covered by the broker-level redelivery backstop
 * (EVO-1677).
 */
const DETERMINISTIC_SQLSTATE_CLASSES = new Set(['42', '22']);
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53', '57', '40']);

/**
 * Extract a PostgreSQL SQLSTATE code from a raw driver error or a TypeORM
 * `QueryFailedError` (which nests the driver error under `driverError`).
 */
export function extractSqlState(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const candidate = err as { code?: unknown; driverError?: { code?: unknown } };
  const code = candidate.driverError?.code ?? candidate.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

export function isDeterministicDbError(err: unknown): boolean {
  const sqlState = extractSqlState(err);
  if (!sqlState) return false;
  const sqlStateClass = sqlState.slice(0, 2);
  if (TRANSIENT_SQLSTATE_CLASSES.has(sqlStateClass)) return false;
  return DETERMINISTIC_SQLSTATE_CLASSES.has(sqlStateClass);
}
