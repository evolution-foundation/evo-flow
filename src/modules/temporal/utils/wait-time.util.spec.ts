import {
  calculateWaitTimes,
  convertToMs,
  isPureTimeWait,
  resolveWaitTimeoutMs,
} from './wait-time.util';

/**
 * EVO-1931 — regression guard for time-based Wait resume.
 *
 * A journey with a TIME-BASED Wait was observed stuck in WAITING for >22s.
 * Investigation conclusion: the time-based resume path is CORRECT and was NOT
 * touched by EVO-1912 (which only changed the post-completion multi-output
 * routing). The workflow resumes a pure-time wait via Temporal `sleep(ms)`,
 * where `ms` is derived here. The >22s observation could never have elapsed the
 * smallest configurable wait, because the only time units are
 * minutes/hours/days — i.e. the minimum non-zero wait is 1 minute (60_000ms).
 *
 * These tests pin that scheduling contract so the timer can never silently
 * become unscheduled (which would manifest as "never resumes"):
 *   - a pure-time wait yields a positive sleep duration (the Temporal timer);
 *   - the workflow keys its `sleep` branch off `metadata.waitType === 'time'`;
 *   - the minimum granularity really is one minute.
 */
describe('wait-time scheduling (EVO-1931 time-based resume)', () => {
  describe('isPureTimeWait — the workflow sleep-branch predicate', () => {
    it('selects the Temporal sleep path for a pure time wait', () => {
      expect(isPureTimeWait('time')).toBe(true);
    });

    it('does NOT select the sleep path for signal-driven waits', () => {
      expect(isPureTimeWait('event')).toBe(false);
      expect(isPureTimeWait('condition')).toBe(false);
      expect(isPureTimeWait('time_or_condition')).toBe(false);
      expect(isPureTimeWait(undefined)).toBe(false);
    });
  });

  describe('resolveWaitTimeoutMs — the sleep duration the workflow schedules', () => {
    it('schedules a positive timer for a time wait (expectedCompleteAt, no fallback)', () => {
      const now = 1_000_000;
      const ms = resolveWaitTimeoutMs(
        { expectedCompleteAt: new Date(now + 60_000) },
        now,
      );
      expect(ms).toBe(60_000);
      // The workflow guards `if (ms > 0) await sleep(ms)`, so this must be > 0,
      // otherwise the wait would resume instantly / never schedule a timer.
      expect(ms!).toBeGreaterThan(0);
    });

    it('prefers fallbackAt when present (event/condition with fallback)', () => {
      const now = 1_000_000;
      const ms = resolveWaitTimeoutMs(
        {
          expectedCompleteAt: new Date(now + 60_000),
          fallbackAt: new Date(now + 30_000),
        },
        now,
      );
      expect(ms).toBe(30_000);
    });

    it('returns undefined when no deadline applies (waits for a signal)', () => {
      expect(resolveWaitTimeoutMs({}, 1_000_000)).toBeUndefined();
    });
  });

  describe('calculateWaitTimes — end-to-end time-based scheduling', () => {
    it('a short time wait schedules a future deadline and a positive sleep', () => {
      const before = Date.now();
      const times = calculateWaitTimes('time', {
        duration: 1,
        timeUnit: 'minutes',
      });

      // Pure time waits expose expectedCompleteAt and NO fallbackAt.
      expect(times.fallbackAt).toBeUndefined();
      expect(times.expectedCompleteAt).toBeInstanceOf(Date);
      expect(times.expectedCompleteAt!.getTime()).toBeGreaterThanOrEqual(
        before + 60_000,
      );

      const ms = resolveWaitTimeoutMs(times);
      expect(ms).toBeGreaterThan(0);
      // The workflow will sleep ~1 minute, then resume — so a 22s observation
      // window legitimately still shows WAITING. This is the non-reproduce.
      expect(ms!).toBeGreaterThan(22_000);
    });

    it('falls back to 1 minute when duration/unit are omitted (minimum granularity)', () => {
      const times = calculateWaitTimes('time', {});
      const ms = resolveWaitTimeoutMs(times)!;
      // Smallest possible non-zero wait: 1 minute. There is no sub-minute unit,
      // so any "short" time wait is at least 60s — never a <22s resume.
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(60_000);
      expect(ms).toBeGreaterThan(22_000);
    });

    it('only supports minutes/hours/days (no seconds) — confirms 60s floor', () => {
      expect(convertToMs(1, 'minutes')).toBe(60_000);
      expect(convertToMs(1, 'hours')).toBe(3_600_000);
      expect(convertToMs(1, 'days')).toBe(86_400_000);
      // Unknown units (e.g. a hypothetical 'seconds') default to minutes,
      // so they can never yield a sub-minute timer either.
      expect(convertToMs(1, 'seconds')).toBe(60_000);
    });
  });
});
