export function convertToMs(value: number, unit: string): number {
  switch (unit) {
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    default:
      return value * 60 * 1000; // Default to minutes
  }
}

/**
 * Compute how many milliseconds remain until a wait should auto-complete.
 *
 * For pure-time waits (`waitType === 'time'`) there is no `fallbackAt`, so the
 * deadline is `expectedCompleteAt`; for event/condition waits with a fallback
 * the deadline is `fallbackAt`. Returns `undefined` when no timer applies
 * (e.g. an event wait with no fallback → waits indefinitely for a signal).
 *
 * This mirrors the `fallbackTimeoutMs` the wait activity hands to the workflow
 * and is the single source of truth the workflow uses to schedule the Temporal
 * `sleep` for time-based resume (EVO-1931).
 */
export function resolveWaitTimeoutMs(
  times: { expectedCompleteAt?: Date; fallbackAt?: Date },
  now: number = Date.now(),
): number | undefined {
  const deadline = times.fallbackAt ?? times.expectedCompleteAt;
  if (!deadline) {
    return undefined;
  }
  return deadline.getTime() - now;
}

/**
 * Whether a wait is a "pure time" wait whose resume is driven by a Temporal
 * `sleep(ms)` rather than by an external completion signal. The workflow keys
 * its scheduling branch off `metadata.waitType === 'time'`; keeping the test
 * pointed at this predicate guards the time-based resume path (EVO-1931).
 */
export function isPureTimeWait(waitType: string | undefined): boolean {
  return waitType === 'time';
}

export function calculateWaitTimes(
  waitType: string,
  config: any,
): {
  expectedCompleteAt?: Date;
  fallbackAt?: Date;
} {
  const now = Date.now();
  let expectedCompleteAt: Date | undefined;
  let fallbackAt: Date | undefined;

  switch (waitType) {
    case 'time': {
      const duration = config.duration || 1;
      const unit = config.timeUnit || 'minutes';
      const ms = convertToMs(duration, unit);
      expectedCompleteAt = new Date(now + ms);
      break;
    }

    case 'event':
    case 'condition': {
      if (config.enableFallback && config.fallbackTime) {
        const fallbackMs = convertToMs(
          config.fallbackTime,
          config.fallbackUnit || 'hours',
        );
        fallbackAt = new Date(now + fallbackMs);
      }
      break;
    }

    case 'time_or_condition': {
      const maxTime = config.maxWaitTime || 1;
      const maxUnit = config.maxWaitUnit || 'hours';
      const maxMs = convertToMs(maxTime, maxUnit);
      expectedCompleteAt = new Date(now + maxMs);
      break;
    }
  }

  return { expectedCompleteAt, fallbackAt };
}
