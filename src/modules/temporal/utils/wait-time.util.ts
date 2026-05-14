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
