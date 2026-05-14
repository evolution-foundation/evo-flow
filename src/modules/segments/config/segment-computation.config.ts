export enum SegmentComputationType {
  REAL_TIME = 'real-time',
  CRON_JOB = 'cron-job',
  BOTH = 'both',
}

export interface SegmentComputationConfig {
  type: SegmentComputationType;
  enableRealTime: boolean;
  enableCronJob: boolean;
  maxConcurrentAccounts: number;
  maxConcurrentSegments: number;
}

export function getSegmentComputationConfig(): SegmentComputationConfig {
  const type = (
    process.env.SEGMENT_COMPUTATION_TYPE || 'real-time'
  ).toLowerCase() as SegmentComputationType;
  
  const runMode = process.env.RUN_MODE || 'single';

  let enableRealTime = false;
  let enableCronJob = false;

  // Override based on RunMode for SEGMENT-WORKER
  if (runMode === 'segment-worker') {
    // SEGMENT-WORKER should enable cron jobs by default
    enableRealTime = true; // Keep real-time for atomic processing
    enableCronJob = true;  // Enable cron jobs for batch processing
  } else {
    switch (type) {
      case SegmentComputationType.REAL_TIME:
        enableRealTime = true;
        enableCronJob = false;
        break;
      case SegmentComputationType.CRON_JOB:
        enableRealTime = false;
        enableCronJob = true;
        break;
      case SegmentComputationType.BOTH:
        enableRealTime = true;
        enableCronJob = true;
        break;
      default:
        // Default to real-time if invalid value
        enableRealTime = true;
        enableCronJob = false;
    }
  }

  // Performance configuration
  const maxConcurrentAccounts = parseInt(
    process.env.SEGMENT_MAX_CONCURRENT_ACCOUNTS || '3',
    10,
  );
  const maxConcurrentSegments = parseInt(
    process.env.SEGMENT_MAX_CONCURRENT_SEGMENTS || '2',
    10,
  );

  return {
    type,
    enableRealTime,
    enableCronJob,
    maxConcurrentAccounts,
    maxConcurrentSegments,
  };
}
