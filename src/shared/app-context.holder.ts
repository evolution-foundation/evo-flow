import type { INestApplicationContext } from '@nestjs/common';

/**
 * Primary Nest application context, stashed at boot (main.ts) so Temporal
 * activities can resolve DI services WITHOUT bootstrapping a second AppModule.
 *
 * EVO-1829: action-node activities run outside the Nest container. Each used to
 * call `NestFactory.createApplicationContext(AppModule.forRoot())`, which boots
 * a full second app (Kafka consumers, a redundant Temporal worker, scheduled
 * jobs) in-process and silently freezes single-mode. The primary context built
 * by `NestFactory.create()` already provides every service those activities
 * need and is guaranteed to exist before any activity dispatch, so they reuse
 * it from here.
 *
 * Out of scope: `journey-tracking.activities.ts` deliberately does
 * `new KafkaService()` (a producer-only force-init) — do NOT route it here.
 */
let appContext: INestApplicationContext | null = null;

export function setAppContext(context: INestApplicationContext): void {
  appContext = context;
}

export function getAppContext(): INestApplicationContext {
  if (!appContext) {
    throw new Error(
      'App context not initialized: setAppContext() must run at boot before any Temporal activity',
    );
  }
  return appContext;
}
