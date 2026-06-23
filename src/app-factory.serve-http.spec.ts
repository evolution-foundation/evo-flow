import { AppFactory } from './app-factory';
import { RunMode } from './modules/processing/enums/run-mode.enum';

// AppFactory reads RUN_MODE via getProcessingConfig() -> process.env.RUN_MODE.
const withRunMode = (mode: string, fn: () => void) => {
  const prev = process.env.RUN_MODE;
  process.env.RUN_MODE = mode;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.RUN_MODE;
    else process.env.RUN_MODE = prev;
  }
};

describe('AppFactory.shouldServeHttp', () => {
  const serve = [
    RunMode.SINGLE,
    RunMode.API,
    RunMode.EVENT_RECEIVER,
    RunMode.CAMPAIGN_PACKER,
    RunMode.CAMPAIGN_SENDER,
    RunMode.CAMPAIGN_TRACKER,
    RunMode.EVENT_PROCESS,
    // EVO-1764: the dedicated journey worker opens the probe listener so its
    // /ready (queue-health) + /metrics (poller gauges) are scrapeable.
    RunMode.TEMPORAL_WORKER,
  ];
  const noServe = [
    RunMode.EVENT_WORKER,
    RunMode.SEGMENT_WORKER,
    RunMode.CAMPAIGN_WORKER,
  ];

  it.each(serve)('%s serves HTTP (probes reachable)', (mode) => {
    withRunMode(mode, () => expect(AppFactory.shouldServeHttp()).toBe(true));
  });

  it.each(noServe)('%s stays listener-less', (mode) => {
    withRunMode(mode, () => expect(AppFactory.shouldServeHttp()).toBe(false));
  });

  it('every full-API mode (shouldStartHttpServer) also serves HTTP', () => {
    for (const mode of [RunMode.SINGLE, RunMode.API, RunMode.EVENT_RECEIVER]) {
      withRunMode(mode, () => {
        expect(AppFactory.shouldStartHttpServer()).toBe(true);
        expect(AppFactory.shouldServeHttp()).toBe(true);
      });
    }
  });
});
